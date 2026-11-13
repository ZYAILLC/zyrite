import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, type DecorationAttrs, DecorationSet } from 'prosemirror-view';
import { schema } from './schema';

/**
 * 所见即所得里的行内 HTML：`<span style="color:red">文字</span>`、`<kbd>`、`<sub>`、`<u>` 等。
 *
 * 原文里开、闭标签是两个独立的 html_inline 节点，中间的文字是普通文字。这里成对配上开闭标签，
 * 给中间的文字加一个行内装饰（用对应的元素包起来，带上过滤后的样式），标签本身平时隐藏；
 * 光标进到这一对标签的范围里时，标签显示出来，可以直接改。原文不受影响。
 */

/** 允许渲染的格式标签 → 用来包文字的元素 */
const TAGS: Record<string, string> = {
  span: 'span',
  font: 'span',
  kbd: 'kbd',
  sub: 'sub',
  sup: 'sup',
  u: 'u',
  ins: 'ins',
  mark: 'mark',
  b: 'strong',
  strong: 'strong',
  i: 'em',
  em: 'em',
  s: 's',
  del: 'del',
  strike: 's',
  small: 'small',
  big: 'big',
  abbr: 'abbr',
  q: 'q',
  cite: 'cite',
  code: 'code',
  var: 'var',
  samp: 'samp',
};

/** 内联样式里允许的属性；其余（定位、url() 等）丢掉 */
const STYLE_PROPS = new Set([
  'color',
  'background',
  'background-color',
  'font-weight',
  'font-style',
  'font-size',
  'font-family',
  'font-variant',
  'text-decoration',
  'text-decoration-color',
  'text-decoration-line',
  'text-decoration-style',
  'letter-spacing',
]);

const OPEN = /^<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*>$/;
const CLOSE = /^<\/([a-zA-Z][\w-]*)\s*>$/;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) out.set((m[1] ?? '').toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/** 过滤内联样式：只留 STYLE_PROPS 里的属性，去掉 url()、expression() 之类 */
export function safeStyle(style: string): string {
  const out: string[] = [];
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop) || !value || /url\s*\(|expression\s*\(|[<>{}\\]/i.test(value)) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join('; ');
}

/** 开标签 → 行内装饰的属性；不认识的标签返回 null（照常显示成源码） */
export function openTagAttrs(html: string): { tag: string; attrs: DecorationAttrs } | null {
  const m = OPEN.exec(html.trim());
  if (!m) return null;
  const tag = (m[1] ?? '').toLowerCase();
  const nodeName = TAGS[tag];
  if (!nodeName) return null;
  const attrs = parseAttrs(m[2] ?? '');
  const styles: string[] = [];
  const style = attrs.get('style');
  if (style) styles.push(safeStyle(style));
  if (tag === 'font') {
    const color = attrs.get('color');
    if (color && /^[#\w(),.\s%-]+$/.test(color)) styles.push(`color: ${color}`);
    const face = attrs.get('face');
    if (face && /^[\w\s,'"-]+$/.test(face)) styles.push(`font-family: ${face}`);
  }
  const out: DecorationAttrs = { nodeName, class: 'zy-html' };
  const css = styles.filter(Boolean).join('; ');
  if (css) out.style = css;
  const title = attrs.get('title');
  if (title) out.title = title;
  return { tag, attrs: out };
}

const key = new PluginKey<DecorationSet>('zy-html-inline');

/** 一个文本块里配好对的开闭标签：开标签位置、闭标签位置、包文字用的属性 */
interface Pair {
  open: number;
  close: number;
  attrs: DecorationAttrs;
}

function pairsIn(block: PMNode, start: number): Pair[] {
  const pairs: Pair[] = [];
  const stack: { tag: string; pos: number; attrs: DecorationAttrs }[] = [];
  block.forEach((child, offset) => {
    if (child.type !== schema.nodes.html_inline) return;
    const value = String(child.attrs.value);
    const pos = start + offset;
    const open = openTagAttrs(value);
    if (open) {
      stack.push({ tag: open.tag, pos, attrs: open.attrs });
      return;
    }
    const close = CLOSE.exec(value.trim());
    if (!close) return;
    const tag = (close[1] ?? '').toLowerCase();
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.tag !== tag) continue;
      const o = stack[i]!;
      stack.length = i;
      pairs.push({ open: o.pos, close: pos, attrs: o.attrs });
      break;
    }
  });
  return pairs;
}

function build(doc: PMNode, selFrom: number, selTo: number): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    for (const p of pairsIn(node, pos + 1)) {
      // 标签节点各占 1 个位置；中间的文字从 open + 1 到 close
      if (p.close > p.open + 1) decos.push(Decoration.inline(p.open + 1, p.close, p.attrs));
      const active = selFrom <= p.close + 1 && selTo >= p.open;
      const cls = active ? 'zy-html-tag zy-html-tag-active' : 'zy-html-tag';
      decos.push(Decoration.node(p.open, p.open + 1, { class: cls }));
      decos.push(Decoration.node(p.close, p.close + 1, { class: cls }));
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export function htmlInline(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => build(state.doc, state.selection.from, state.selection.to),
      apply: (tr, value, _old, state) =>
        tr.docChanged || tr.selectionSet ? build(state.doc, state.selection.from, state.selection.to) : value,
    },
    props: { decorations: (state) => key.getState(state) },
  });
}
