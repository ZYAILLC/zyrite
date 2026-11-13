import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, StateField, type Transaction } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  type WidgetType,
} from '@codemirror/view';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import type { EditorLabels, LinkStatusFn, ResolveUrl } from '@zyrite/editor-common';
import { StateEffect } from '@codemirror/state';
import { activeRanges, currentBlock, focusedField, setFocused, type Span, touches } from './active';
import {
  BulletWidget,
  FenceWidget,
  FigureWidget,
  FrontmatterWidget,
  ImageWidget,
  InlineMathWidget,
  RuleWidget,
  TableWidget,
  TaskWidget,
} from './widgets';

/**
 * 实时预览的装饰：当前块显示 Markdown 标记，其他地方渲染。
 * - 跨行的块（表格、公式块、Mermaid、frontmatter）整块换成渲染结果，放在 StateField 里（CodeMirror 要求跨行替换不能来自 ViewPlugin）
 * - 行内的隐藏标记、样式、图片、公式等只算可见区域，放在 ViewPlugin 里
 */

export interface PreviewOptions {
  resolveUrl?: ResolveUrl;
  labels: EditorLabels;
  linkStatus?: LinkStatusFn;
}

/** 库里的笔记变了，重新判断双链是否存在 */
export const linksChanged = StateEffect.define<null>();

const hidden = Decoration.replace({});
const mark = (cls: string) => Decoration.mark({ class: cls });
const line = (cls: string) => Decoration.line({ class: cls });

const STYLE: Record<string, Decoration> = {
  Emphasis: mark('zy-em'),
  StrongEmphasis: mark('zy-strong'),
  Strikethrough: mark('zy-del'),
  Highlight: mark('zy-hl'),
  InlineCode: mark('zy-icode'),
  Tag: mark('zy-tag'),
};
const SYNTAX = mark('zy-syntax');
const LINK = mark('zy-link');
const LINK_MISSING = mark('zy-link zy-link-missing');
const MATH_SRC = mark('zy-math-src');
const CALLOUT = mark('callout-mark');
const INLINE_MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'HighlightMark', 'CodeMark', 'InlineMathMark']);

function text(state: EditorState, node: { from: number; to: number }) {
  return state.sliceDoc(node.from, node.to);
}

function children(node: SyntaxNode, name: string): SyntaxNode[] {
  return node.getChildren(name);
}

/** frontmatter 里的顶层键数 */
function frontmatterCount(source: string): number {
  return source
    .split('\n')
    .slice(1)
    .filter((l) => /^[^\s#-][^:]*:/.test(l)).length;
}

// ---------- 块级 ----------

function blockWidget(state: EditorState, node: SyntaxNode, opts: PreviewOptions): WidgetType | null {
  switch (node.name) {
    case 'Table':
      return new TableWidget(text(state, node), opts.resolveUrl);
    case 'MathBlock': {
      const src = text(state, node).replace(/^\s*\$\$/, '');
      const close = src.lastIndexOf('$$');
      return new FigureWidget('math', (close >= 0 ? src.slice(0, close) : src).trim());
    }
    case 'FencedCode': {
      const info = node.getChild('CodeInfo');
      if (!info || text(state, info).trim().toLowerCase() !== 'mermaid') return null;
      const code = node.getChild('CodeText');
      return new FigureWidget('mermaid', code ? text(state, code) : '');
    }
    case 'Frontmatter':
      return new FrontmatterWidget(opts.labels.frontmatter(frontmatterCount(text(state, node))));
    default:
      return null;
  }
}

function buildBlocks(state: EditorState, opts: PreviewOptions): DecorationSet {
  const active = activeRanges(state);
  const decos: Range<Decoration>[] = [];
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (touches(active, node.from, node.to)) continue;
    const widget = blockWidget(state, node, opts);
    if (!widget) continue;
    // 整块替换必须从行首到行尾
    const from = state.doc.lineAt(node.from).from;
    const to = state.doc.lineAt(node.to).to;
    decos.push(Decoration.replace({ widget, block: true }).range(from, to));
  }
  return Decoration.set(decos);
}

function previewTouched(tr: Transaction): boolean {
  return (
    tr.docChanged ||
    tr.selection !== undefined ||
    tr.effects.some((e) => e.is(setFocused) || e.is(linksChanged)) ||
    syntaxTree(tr.state) !== syntaxTree(tr.startState)
  );
}

function blockField(opts: PreviewOptions) {
  return StateField.define<DecorationSet>({
    create: (state) => buildBlocks(state, opts),
    update: (value, tr) => (previewTouched(tr) ? buildBlocks(tr.state, opts) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
}

// ---------- 行内 ----------

/** 隐藏一个标记；在行首时连同后面的空格，在行尾时连同前面的空格 */
function hideMark(state: EditorState, out: Range<Decoration>[], from: number, to: number) {
  const ln = state.doc.lineAt(from);
  const before = state.sliceDoc(ln.from, from);
  if (/^\s*$/.test(before)) {
    const rest = state.sliceDoc(to, ln.to);
    to += rest.length - rest.trimStart().length;
  } else if (state.sliceDoc(to, ln.to).trim() === '') {
    from -= before.length - before.trimEnd().length;
  }
  if (from < to) out.push(hidden.range(from, to));
}

function lineClasses(state: EditorState, out: Range<Decoration>[], from: number, to: number, cls: (i: number, n: number) => string) {
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  for (let n = first; n <= last; n++) {
    out.push(line(cls(n - first, last - first + 1)).range(state.doc.line(n).from));
  }
}

/** 引用式链接的标签，按 CommonMark 规则归一（大小写、空白不敏感） */
function normLabel(label: string): string {
  return label.replace(/^\[|\]$/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 文档里定义过的链接引用 `[label]: url` */
function definedLabels(state: EditorState): Set<string> {
  const out = new Set<string>();
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== 'LinkReference') continue;
    const label = node.getChild('LinkLabel');
    if (label) out.add(normLabel(text(state, label)));
  }
  return out;
}

function buildInline(view: EditorView, opts: PreviewOptions): DecorationSet {
  const { state } = view;
  const active = activeRanges(state);
  const labels = definedLabels(state);
  const out: Range<Decoration>[] = [];
  const isActive = (n: { from: number; to: number }) => touches(active, n.from, n.to);
  const { from, to } = view.viewport;

  syntaxTree(state).iterate({
    from,
    to,
    enter(ref: SyntaxNodeRef): boolean | void {
      const { name } = ref;
      const node = ref.node;
      const on = isActive(ref);

      const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
      if (heading) {
        lineClasses(state, out, ref.from, ref.to, () => `zy-h zy-h${heading[2]}`);
        return;
      }
      if (name === 'HeaderMark') {
        if (on) out.push(SYNTAX.range(ref.from, ref.to));
        else hideMark(state, out, ref.from, ref.to);
        return;
      }

      const style = STYLE[name];
      if (style) {
        if (ref.from < ref.to) out.push(style.range(ref.from, ref.to));
        return;
      }
      if (INLINE_MARKS.has(name)) {
        const parent = node.parent?.name;
        if (parent === 'FencedCode') return;
        if (on || parent === 'InlineMath') out.push(SYNTAX.range(ref.from, ref.to));
        else out.push(hidden.range(ref.from, ref.to));
        return;
      }

      switch (name) {
        case 'FencedCode':
        case 'CodeBlock': {
          // 不在当前块的 Mermaid 已整块换成图
          if (!on && name === 'FencedCode' && blockWidget(state, node, opts)) return false;
          lineClasses(state, out, ref.from, ref.to, (i, n) =>
            ['zy-codeblock', i === 0 ? 'zy-codeblock-first' : '', i === n - 1 ? 'zy-codeblock-last' : '']
              .filter(Boolean)
              .join(' '),
          );
          if (name === 'FencedCode') {
            const marks = children(node, 'CodeMark');
            const info = node.getChild('CodeInfo');
            const open = marks[0];
            const close = marks.length > 1 ? marks[marks.length - 1] : undefined;
            if (on) {
              for (const m of marks) out.push(SYNTAX.range(m.from, m.to));
              if (info) out.push(SYNTAX.range(info.from, info.to));
            } else {
              if (open) {
                out.push(line('zy-fence-line').range(state.doc.lineAt(open.from).from));
                const end = state.doc.lineAt(open.from).to;
                const lang = info ? text(state, info).trim() : '';
                out.push(
                  lang ? Decoration.replace({ widget: new FenceWidget(lang) }).range(open.from, end) : hidden.range(open.from, end),
                );
              }
              if (close) {
                const ln = state.doc.lineAt(close.from);
                out.push(line('zy-fence-line').range(ln.from), hidden.range(ln.from, close.to));
              }
            }
          }
          return false;
        }
        case 'MathBlock':
        case 'Frontmatter':
          // 不在当前块时已整块替换；在当前块时按源码显示
          if (!on) return false;
          lineClasses(state, out, ref.from, ref.to, (i, n) =>
            ['zy-codeblock', i === 0 ? 'zy-codeblock-first' : '', i === n - 1 ? 'zy-codeblock-last' : '']
              .filter(Boolean)
              .join(' '),
          );
          return false;
        case 'Table':
          if (on) lineClasses(state, out, ref.from, ref.to, () => 'zy-table-src');
          return false;
        case 'Blockquote': {
          lineClasses(state, out, ref.from, ref.to, () => 'zy-quote');
          const first = state.doc.lineAt(ref.from);
          const callout = /^(\s*>\s*)(\[![\w-]+\][-+]?)/.exec(first.text);
          if (callout?.[1] !== undefined && callout[2]) {
            const s = first.from + callout[1].length;
            out.push(CALLOUT.range(s, s + callout[2].length));
          }
          return;
        }
        case 'QuoteMark':
          if (on) out.push(SYNTAX.range(ref.from, ref.to));
          else {
            const next = state.sliceDoc(ref.to, ref.to + 1);
            out.push(hidden.range(ref.from, next === ' ' ? ref.to + 1 : ref.to));
          }
          return;
        case 'ListMark': {
          const list = node.parent?.parent?.name;
          if (on) out.push(SYNTAX.range(ref.from, ref.to));
          else if (list === 'BulletList' && !node.parent?.getChild('Task')) {
            out.push(Decoration.replace({ widget: new BulletWidget() }).range(ref.from, ref.to));
          } else if (list === 'BulletList') {
            // 任务项只显示复选框
            const next = state.sliceDoc(ref.to, ref.to + 1);
            out.push(hidden.range(ref.from, next === ' ' ? ref.to + 1 : ref.to));
          } else out.push(mark('zy-listmark').range(ref.from, ref.to));
          return;
        }
        case 'TaskMarker': {
          if (on) out.push(SYNTAX.range(ref.from, ref.to));
          else {
            const checked = /x/i.test(text(state, ref));
            out.push(Decoration.replace({ widget: new TaskWidget(checked) }).range(ref.from, ref.to));
            if (checked) out.push(line('zy-task-done').range(state.doc.lineAt(ref.from).from));
          }
          return;
        }
        case 'HorizontalRule':
          if (!on) out.push(Decoration.replace({ widget: new RuleWidget() }).range(ref.from, ref.to));
          else out.push(SYNTAX.range(ref.from, ref.to));
          return;
        case 'Link':
        case 'Image':
        case 'Autolink':
          return linkLike(state, node, on, out, opts, labels);
        case 'URL':
          // GFM 裸链接
          if (node.parent?.name !== 'Link' && node.parent?.name !== 'Image' && node.parent?.name !== 'Autolink') {
            out.push(LINK.range(ref.from, ref.to));
          }
          return;
        case 'LinkReference': {
          // `[^1]: 说明` 在说明只有一个词时会被解析成链接引用定义，这里按脚注定义显示
          const label = node.getChild('LinkLabel');
          if (label && state.sliceDoc(label.from, label.from + 2) === '[^') {
            if (on) {
              out.push(SYNTAX.range(label.from, label.from + 2), SYNTAX.range(label.to - 1, label.to + 1));
            } else {
              out.push(hidden.range(label.from, label.from + 2));
              out.push(mark('zy-fndef').range(label.from + 2, label.to - 1));
              out.push(hidden.range(label.to - 1, Math.min(label.to + 1, ref.to)));
            }
            return false;
          }
          out.push(SYNTAX.range(ref.from, ref.to));
          return false;
        }
        case 'WikiLink': {
          const src = text(state, ref);
          const open = src.startsWith('!') ? 3 : 2;
          const inner = src.slice(open, -2);
          const target = (inner.split(/[|#]/)[0] ?? '').trim();
          // 链接到不存在的笔记显示成虚线
          const link = opts.linkStatus?.(target) === 'missing' ? LINK_MISSING : LINK;
          if (on) {
            out.push(SYNTAX.range(ref.from, ref.from + open), SYNTAX.range(ref.to - 2, ref.to));
            out.push(link.range(ref.from + open, ref.to - 2));
            return false;
          }
          const bar = inner.indexOf('|');
          const textFrom = ref.from + open + (bar >= 0 ? bar + 1 : 0);
          out.push(hidden.range(ref.from, textFrom));
          if (textFrom < ref.to - 2) out.push(link.range(textFrom, ref.to - 2));
          out.push(hidden.range(ref.to - 2, ref.to));
          return false;
        }
        case 'InlineMath':
          if (on) {
            out.push(MATH_SRC.range(ref.from, ref.to));
            return;
          }
          out.push(Decoration.replace({ widget: new InlineMathWidget(text(state, ref).slice(1, -1)) }).range(ref.from, ref.to));
          return false;
        case 'FootnoteRef': {
          const close = ref.to - 1;
          // 行首且后面跟冒号：脚注定义 `[^1]: 说明`
          const isDef = state.sliceDoc(ref.to, ref.to + 1) === ':' && state.doc.lineAt(ref.from).from === ref.from;
          if (on) {
            out.push(SYNTAX.range(ref.from, ref.from + 2), SYNTAX.range(close, ref.to));
            return false;
          }
          out.push(hidden.range(ref.from, ref.from + 2));
          out.push(mark(isDef ? 'zy-fndef' : 'zy-fnref').range(ref.from + 2, close));
          out.push(hidden.range(close, isDef ? ref.to + 1 : ref.to));
          return false;
        }
        case 'Escape':
          if (!on) out.push(hidden.range(ref.from, ref.from + 1));
          return;
        case 'HTMLTag':
        case 'Comment':
        case 'CommentBlock':
          out.push(SYNTAX.range(ref.from, ref.to));
          return;
        default:
          return;
      }
    },
  });
  // 空的 mark 装饰不合法（例如空链接文字），去掉
  return Decoration.set(
    out.filter((r) => r.value.point || r.from < r.to),
    true,
  );
}

/** 链接、图片、尖括号链接 */
function linkLike(
  state: EditorState,
  node: SyntaxNode,
  on: boolean,
  out: Range<Decoration>[],
  opts: PreviewOptions,
  labels: ReadonlySet<string>,
) {
  const marks = children(node, 'LinkMark');
  const url = node.getChild('URL');
  // lezer 把所有 `[文字]` 都当链接；没有对应引用定义的（例如 callout 的 `[!note]`、`[1]`）按普通文字处理
  if (!url && node.name !== 'Autolink') {
    const [open, close] = marks;
    const label = node.getChild('LinkLabel');
    const key = label && label.to - label.from > 2 ? text(state, label) : open && close ? state.sliceDoc(open.to, close.from) : '';
    if (!labels.has(normLabel(key))) return;
  }
  if (on) {
    for (const m of marks) out.push(SYNTAX.range(m.from, m.to));
    for (const n of [url, node.getChild('LinkTitle'), node.getChild('LinkLabel')]) {
      if (n) out.push(SYNTAX.range(n.from, n.to));
    }
    const [open, close] = marks;
    if (node.name === 'Link' && open && close && open.to < close.from) out.push(LINK.range(open.to, close.from));
    if (node.name === 'Autolink' && url) out.push(LINK.range(url.from, url.to));
    return;
  }
  if (node.name === 'Image') {
    const [open, close] = marks;
    const alt = open && close ? state.sliceDoc(open.to, close.from) : '';
    if (url) {
      out.push(
        Decoration.replace({ widget: new ImageWidget(text(state, url), alt, opts.resolveUrl) }).range(node.from, node.to),
      );
      return false;
    }
    return;
  }
  if (node.name === 'Autolink') {
    for (const m of marks) out.push(hidden.range(m.from, m.to));
    if (url) out.push(LINK.range(url.from, url.to));
    return false;
  }
  // [文字](地址 "标题")、[文字][引用]、[文字]
  const [open, close] = marks;
  if (!open || !close) return;
  out.push(hidden.range(open.from, open.to));
  if (open.to < close.from) out.push(LINK.range(open.to, close.from));
  out.push(hidden.range(close.from, node.to));
  return;
}

function inlinePlugin(opts: PreviewOptions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildInline(view, opts);
      }
      update(u: ViewUpdate) {
        if (u.viewportChanged || u.transactions.some(previewTouched)) {
          this.decorations = buildInline(u.view, opts);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** 专注模式：当前块以外变淡 */
export const focusModePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const { state } = view;
      const cur: Span = currentBlock(state);
      const dim = line('zy-dim');
      const out: Range<Decoration>[] = [];
      for (let pos = view.viewport.from; pos <= view.viewport.to; ) {
        const ln = state.doc.lineAt(pos);
        if (ln.to < cur.from || ln.from > cur.to) out.push(dim.range(ln.from));
        pos = ln.to + 1;
      }
      return Decoration.set(out);
    }
  },
  { decorations: (v) => v.decorations },
);

export function livePreview(opts: PreviewOptions): Extension {
  return [focusedField, blockField(opts), inlinePlugin(opts)];
}
