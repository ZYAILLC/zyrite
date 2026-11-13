import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { Compartment } from '@codemirror/state';
import {
  drawSelection,
  EditorView as CMView,
  keymap as cmKeymap,
  type ViewUpdate,
} from '@codemirror/view';
import {
  codeHighlightStyle,
  defaultLabels,
  type EditorLabels,
  findLanguage,
  renderMath,
  renderMermaid,
  type ResolveUrl,
} from '@zyrite/editor-common';
import { redo, undo } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { Selection, TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import { exitCode } from 'prosemirror-commands';
import { schema } from './schema';

export type { EditorLabels };
export { defaultLabels };

type GetPos = () => number | undefined;

/**
 * 代码块、公式块、源码块：内嵌一个 CodeMirror（参照 prosemirror.net 的 codemirror 示例）。
 * - code_block：语法高亮，右上角可改语言；mermaid 代码块平时只显示图，点开看源码
 * - math_block：平时显示公式，点开看源码
 * - raw_block：HTML、引用定义、脚注定义等无法所见即所得的块，直接编辑源码；frontmatter 默认折叠成一行
 */
export class CodeView implements NodeView {
  dom: HTMLElement;
  private cm: CMView;
  /** 包住 CodeMirror 的元素：.cm-editor 自带 `display: flex !important`，隐藏源码只能隐藏外层 */
  private source: HTMLElement;
  private updating = false;
  private readonly lang = new Compartment();
  private langInput?: HTMLInputElement;
  private figure?: HTMLElement;
  private summary?: HTMLButtonElement;
  private editing = false;
  private rendered = '';

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: GetPos,
    private readonly labels: EditorLabels,
  ) {
    this.dom = document.createElement('div');
    // md-fences / md-math-block 是 Typora 的类名，Typora 主题按它给代码块、公式块加样式
    const typora = node.type.name === 'code_block' ? ' md-fences' : node.type.name === 'math_block' ? ' md-math-block' : '';
    this.dom.className = `zy-code zy-${node.type.name}${typora}`;
    this.cm = new CMView({
      doc: node.textContent,
      extensions: [
        cmKeymap.of([...this.escapeKeymap(), indentWithTab, ...defaultKeymap]),
        drawSelection(),
        syntaxHighlighting(codeHighlightStyle),
        this.lang.of([]),
        CMView.lineWrapping,
        CMView.updateListener.of((u) => this.forwardUpdate(u)),
        CMView.domEventHandlers({
          blur: () => {
            if (this.hasPreview()) setTimeout(() => this.setEditing(false), 0);
          },
        }),
      ],
    });

    if (node.type.name === 'code_block') {
      const input = document.createElement('input');
      input.className = 'zy-code-lang';
      input.placeholder = labels.language;
      input.value = node.attrs.lang ?? '';
      input.spellcheck = false;
      input.setAttribute('aria-label', labels.language);
      input.addEventListener('change', () => this.setAttr('lang', input.value.trim() || null));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          this.cm.focus();
        }
      });
      this.langInput = input;
      this.dom.append(input);
    }

    if (node.type.name === 'raw_block' && node.attrs.kind === 'yaml') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'zy-frontmatter-summary';
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.setEditing(true);
        this.cm.focus();
      });
      this.summary = btn;
    }

    this.source = document.createElement('div');
    this.source.className = 'zy-code-source';
    this.source.append(this.cm.dom);
    this.dom.append(this.source);
    this.loadLanguage();
    this.refreshPreview();
  }

  /** 平时显示渲染结果（公式、Mermaid、折叠的 frontmatter），编辑时显示源码 */
  private hasPreview(): boolean {
    const n = this.node;
    return (
      n.type.name === 'math_block' ||
      (n.type.name === 'code_block' && n.attrs.lang === 'mermaid') ||
      (n.type.name === 'raw_block' && n.attrs.kind === 'yaml')
    );
  }

  private setEditing(on: boolean) {
    if (this.editing === on) return;
    this.editing = on;
    this.refreshPreview();
  }

  private refreshPreview() {
    const preview = this.hasPreview();
    const showSource = !preview || this.editing;
    this.source.style.display = showSource ? '' : 'none';
    if (this.langInput) this.langInput.style.display = showSource ? '' : 'none';
    this.dom.classList.toggle('zy-code-collapsed', !showSource);
    // 代码块底色只在显示源码时出现
    this.dom.style.background = showSource ? '' : 'transparent';

    if (this.node.type.name === 'raw_block' && this.node.attrs.kind === 'yaml') {
      const count = this.node.textContent.split('\n').filter((l) => /^[^\s#][^:]*:/.test(l)).length;
      this.summary!.textContent = this.labels.frontmatter(count);
      if (!showSource) this.dom.replaceChildren(this.summary!, this.source);
      else if (this.summary!.parentNode) this.summary!.remove();
      return;
    }

    if (!preview) {
      this.figure?.remove();
      this.figure = undefined;
      return;
    }
    if (!this.figure) {
      this.figure = document.createElement('div');
      this.figure.className = 'zy-figure';
      this.figure.setAttribute('role', 'img');
      this.figure.addEventListener('mousedown', (e) => {
        if (this.editing) return;
        e.preventDefault();
        this.setEditing(true);
        this.cm.focus();
      });
    }
    this.figure.classList.toggle('editing', this.editing);
    if (this.figure.parentNode !== this.dom) this.dom.append(this.figure);
    const text = this.node.textContent;
    const key = `${this.node.type.name}:${text}`;
    if (key !== this.rendered) {
      this.rendered = key;
      this.figure.setAttribute('aria-label', text);
      if (this.node.type.name === 'math_block') renderMath(this.figure, text, true);
      else void renderMermaid(this.figure, text);
    }
  }

  private async loadLanguage() {
    if (this.node.type.name !== 'code_block') return;
    const desc = findLanguage(this.node.attrs.lang);
    if (!desc) {
      this.cm.dispatch({ effects: this.lang.reconfigure([]) });
      return;
    }
    const support = desc.support ?? (await desc.load());
    this.cm.dispatch({ effects: this.lang.reconfigure(support) });
  }

  private setAttr(name: string, value: unknown) {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, name, value));
  }

  private forwardUpdate(update: ViewUpdate) {
    if (this.updating || !this.cm.hasFocus) return;
    const start = this.getPos();
    if (start === undefined) return;
    let offset = start + 1;
    const { main } = update.state.selection;
    const selFrom = offset + main.from;
    const selTo = offset + main.to;
    const pmSel = this.view.state.selection;
    if (update.docChanged || pmSel.from !== selFrom || pmSel.to !== selTo) {
      const tr = this.view.state.tr;
      update.changes.iterChanges((fromA, toA, fromB, toB, text) => {
        if (text.length) tr.replaceWith(offset + fromA, offset + toA, schema.text(text.toString()));
        else tr.delete(offset + fromA, offset + toA);
        offset += toB - fromB - (toA - fromA);
      });
      tr.setSelection(TextSelection.create(tr.doc, selFrom, selTo));
      this.view.dispatch(tr);
    }
  }

  setSelection(anchor: number, head: number) {
    this.setEditing(true);
    this.cm.focus();
    this.updating = true;
    this.cm.dispatch({ selection: { anchor, head } });
    this.updating = false;
  }

  private escapeKeymap() {
    const view = this.view;
    return [
      { key: 'ArrowUp', run: () => this.maybeEscape('line', -1) },
      { key: 'ArrowLeft', run: () => this.maybeEscape('char', -1) },
      { key: 'ArrowDown', run: () => this.maybeEscape('line', 1) },
      { key: 'ArrowRight', run: () => this.maybeEscape('char', 1) },
      {
        key: 'Mod-Enter',
        run: () => {
          if (!exitCode(view.state, view.dispatch)) return false;
          view.focus();
          return true;
        },
      },
      { key: 'Mod-z', run: () => undo(view.state, view.dispatch) },
      { key: 'Mod-Shift-z', run: () => redo(view.state, view.dispatch) },
      { key: 'Mod-y', run: () => redo(view.state, view.dispatch) },
      {
        // 空代码块里按退格：变回段落
        key: 'Backspace',
        run: () => {
          if (this.cm.state.doc.length) return false;
          const pos = this.getPos();
          if (pos === undefined) return false;
          const tr = view.state.tr.setBlockType(pos, pos + this.node.nodeSize, schema.nodes.paragraph!);
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)));
          view.focus();
          return true;
        },
      },
    ];
  }

  private maybeEscape(unit: 'line' | 'char', dir: -1 | 1): boolean {
    const { state } = this.cm;
    let range: { from: number; to: number; empty?: boolean } = state.selection.main;
    if (!state.selection.main.empty) return false;
    if (unit === 'line') range = state.doc.lineAt(state.selection.main.head);
    if (dir < 0 ? range.from > 0 : range.to < state.doc.length) return false;
    const pos = this.getPos();
    if (pos === undefined) return false;
    const target = pos + (dir < 0 ? 0 : this.node.nodeSize);
    const selection = Selection.near(this.view.state.doc.resolve(target), dir);
    this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView());
    this.view.focus();
    return true;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const langChanged = node.attrs.lang !== this.node.attrs.lang;
    this.node = node;
    if (this.langInput && document.activeElement !== this.langInput) this.langInput.value = node.attrs.lang ?? '';
    if (langChanged) void this.loadLanguage();
    if (!this.updating) {
      const newText = node.textContent;
      const curText = this.cm.state.doc.toString();
      if (newText !== curText) {
        let start = 0;
        let curEnd = curText.length;
        let newEnd = newText.length;
        while (start < curEnd && curText.charCodeAt(start) === newText.charCodeAt(start)) ++start;
        while (curEnd > start && newEnd > start && curText.charCodeAt(curEnd - 1) === newText.charCodeAt(newEnd - 1)) {
          curEnd--;
          newEnd--;
        }
        this.updating = true;
        this.cm.dispatch({ changes: { from: start, to: curEnd, insert: newText.slice(start, newEnd) } });
        this.updating = false;
      }
    }
    this.refreshPreview();
    return true;
  }

  selectNode() {
    this.setEditing(true);
    this.cm.focus();
  }

  stopEvent(e: Event): boolean {
    return e.target !== this.dom;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.cm.destroy();
  }
}

/**
 * 行内的公式、双链、标签、HTML、脚注引用：平时显示渲染结果，选中（点击或方向键移入）时变成一个输入框编辑源码。
 */
export class InlineSourceView implements NodeView {
  dom: HTMLElement;
  private input?: HTMLInputElement;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: GetPos,
    private readonly onOpenLink?: (href: string, kind: 'url' | 'wikilink') => void,
  ) {
    this.dom = document.createElement(node.type.name === 'footnote_ref' ? 'sup' : 'span');
    this.render();
    if (node.type.name === 'wikilink') {
      this.dom.addEventListener('mousedown', (e) => {
        if ((e.metaKey || e.ctrlKey) && this.onOpenLink) {
          e.preventDefault();
          this.onOpenLink(String(this.node.attrs.value).split(/[|#]/)[0] ?? '', 'wikilink');
        }
      });
    }
  }

  private source(): string {
    const a = this.node.attrs;
    switch (this.node.type.name) {
      case 'wikilink':
        return `${a.embed ? '!' : ''}[[${a.value}]]`;
      case 'tag':
        return `#${a.value}`;
      case 'inline_math':
        return `$${a.value}$`;
      case 'footnote_ref':
        return `[^${a.label}]`;
      default:
        return String(a.value);
    }
  }

  private parse(text: string): Record<string, unknown> | null {
    const t = text.trim();
    switch (this.node.type.name) {
      case 'wikilink': {
        const m = /^(!?)\[\[([^\[\]\n]+)\]\]$/.exec(t);
        return m ? { value: m[2], embed: m[1] === '!' } : t ? { value: t.replace(/^\[\[|\]\]$/g, ''), embed: false } : null;
      }
      case 'tag':
        return t ? { value: t.replace(/^#/, '') } : null;
      case 'inline_math':
        return t ? { value: t.replace(/^\$|\$$/g, '') } : null;
      case 'footnote_ref':
        return t ? { label: t.replace(/^\[\^|\]$/g, '') } : null;
      default:
        return t ? { value: text } : null;
    }
  }

  private render() {
    const a = this.node.attrs;
    const el = this.dom;
    el.replaceChildren();
    el.contentEditable = 'false';
    switch (this.node.type.name) {
      case 'inline_math':
        el.className = 'inline-math';
        renderMath(el, a.value, false);
        break;
      case 'wikilink': {
        const [target, alias] = String(a.value).split('|');
        // missing 类来自 view.ts 的装饰（链接到不存在的笔记），重绘时保留
        const missing = el.classList.contains('missing');
        el.className = `wikilink${a.embed ? ' embed' : ''}${missing ? ' missing' : ''}`;
        el.textContent = alias ?? target ?? '';
        el.title = String(a.value);
        break;
      }
      case 'tag':
        el.className = 'tag';
        el.textContent = `#${a.value}`;
        break;
      case 'footnote_ref':
        el.className = 'footnote-ref';
        el.textContent = `[${a.label}]`;
        break;
      default:
        el.className = 'html-inline';
        el.textContent = a.value;
    }
  }

  selectNode() {
    if (this.input) return;
    const input = document.createElement('input');
    input.className = 'zy-inline-source';
    input.value = this.source();
    input.size = Math.max(2, input.value.length);
    input.spellcheck = false;
    input.addEventListener('input', () => (input.size = Math.max(2, input.value.length)));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.commit(1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancel();
      } else if (e.key === 'ArrowLeft' && input.selectionStart === 0 && input.selectionEnd === 0) {
        e.preventDefault();
        this.commit(-1);
      } else if (e.key === 'ArrowRight' && input.selectionStart === input.value.length) {
        e.preventDefault();
        this.commit(1);
      }
    });
    input.addEventListener('blur', () => this.commit(0));
    this.input = input;
    this.dom.replaceChildren(input);
    this.dom.className = '';
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  deselectNode() {
    if (this.input) this.commit(0);
  }

  private commit(dir: -1 | 0 | 1) {
    const input = this.input;
    if (!input) return;
    this.input = undefined;
    const pos = this.getPos();
    const attrs = this.parse(input.value);
    if (pos === undefined) return;
    let tr = this.view.state.tr;
    if (!attrs) {
      tr = tr.delete(pos, pos + this.node.nodeSize);
    } else if (input.value !== this.source()) {
      tr = tr.setNodeMarkup(pos, null, { ...this.node.attrs, ...attrs });
    }
    if (dir !== 0) {
      const target = dir < 0 ? pos : pos + (attrs ? this.node.nodeSize : 0);
      tr = tr.setSelection(TextSelection.create(tr.doc, target));
    }
    this.render();
    this.view.dispatch(tr);
    if (dir !== 0) this.view.focus();
  }

  private cancel() {
    const pos = this.getPos();
    this.input = undefined;
    this.render();
    if (pos !== undefined) {
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos + this.node.nodeSize)));
    }
    this.view.focus();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (!this.input) this.render();
    return true;
  }

  stopEvent(e: Event): boolean {
    return !!this.input && e.target === this.input;
  }

  ignoreMutation(): boolean {
    return true;
  }
}

/** 任务列表项：左侧可点击的复选框 */
export class ListItemView implements NodeView {
  dom: HTMLLIElement;
  contentDOM: HTMLElement;
  private box?: HTMLInputElement;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: GetPos,
  ) {
    this.dom = document.createElement('li');
    this.contentDOM = document.createElement('div');
    this.dom.append(this.contentDOM);
    this.sync();
  }

  private sync() {
    const checked = this.node.attrs.checked as boolean | null;
    if (checked === null) {
      this.box?.remove();
      this.box = undefined;
      this.dom.className = '';
      this.dom.removeAttribute('data-checked');
      return;
    }
    this.dom.className = 'task-list-item md-task-list-item';
    this.dom.dataset.checked = String(checked);
    if (!this.box) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'task-box';
      box.contentEditable = 'false';
      box.addEventListener('mousedown', (e) => e.preventDefault());
      box.addEventListener('click', (e) => {
        e.preventDefault();
        const pos = this.getPos();
        if (pos === undefined) return;
        this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, 'checked', !this.node.attrs.checked));
      });
      this.box = box;
      this.dom.prepend(box);
    }
    this.box.checked = checked;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    return m.type === 'attributes' || (!!this.box && m.target === this.box);
  }

  stopEvent(e: Event): boolean {
    return e.target === this.box;
  }
}

/** 图片：本地相对路径经 resolveUrl 转换 */
export class ImageView implements NodeView {
  dom: HTMLImageElement;

  constructor(
    private node: PMNode,
    private readonly resolveUrl?: ResolveUrl,
  ) {
    this.dom = document.createElement('img');
    this.sync();
  }

  private sync() {
    const a = this.node.attrs;
    const src = String(a.src ?? '');
    this.dom.src = this.resolveUrl ? this.resolveUrl(src) : src;
    this.dom.alt = a.alt ?? '';
    if (a.title) this.dom.title = a.title;
    else this.dom.removeAttribute('title');
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }
}

/** 从段落/标题出发，方向键可以进入相邻的代码块、公式块、源码块 */
export function arrowIntoCode(dir: 'left' | 'right' | 'up' | 'down') {
  return (
    state: import('prosemirror-state').EditorState,
    dispatch?: (tr: import('prosemirror-state').Transaction) => void,
    view?: EditorView,
  ): boolean => {
    if (!state.selection.empty || !view?.endOfTextblock(dir)) return false;
    const side = dir === 'left' || dir === 'up' ? -1 : 1;
    const $head = state.selection.$head;
    if ($head.depth === 0) return false;
    const next = Selection.near(state.doc.resolve(side > 0 ? $head.after() : $head.before()), side);
    if (next.$head && next.$head.parent.type.spec.code) {
      dispatch?.(state.tr.setSelection(next));
      return true;
    }
    return false;
  };
}
