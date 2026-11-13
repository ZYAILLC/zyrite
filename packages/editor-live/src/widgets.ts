import { type EditorView, WidgetType } from '@codemirror/view';
import { renderMath, renderMermaid, renderTableSource, type ResolveUrl } from '@zyrite/editor-common';

/** 点击渲染结果：光标移到它的源码开头，露出源码 */
function revealOnMouseDown(dom: HTMLElement, view: EditorView) {
  dom.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = view.posAtDOM(dom);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  });
}

// ---------- 块级（整块替换，来自 StateField） ----------

export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly resolveUrl?: ResolveUrl,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'zy-live-table';
    const table = renderTableSource(this.source, this.resolveUrl);
    if (table) wrap.append(table);
    else wrap.textContent = this.source;
    revealOnMouseDown(wrap, view);
    return wrap;
  }
  get estimatedHeight() {
    return this.source.split('\n').length * 36;
  }
  ignoreEvent() {
    return true;
  }
}

/** 公式块、Mermaid：渲染结果放在两条细线之间（与所见即所得一致，见 editor-common/content.css 的 .zy-figure） */
export class FigureWidget extends WidgetType {
  constructor(
    readonly kind: 'math' | 'mermaid',
    readonly source: string,
  ) {
    super();
  }
  eq(other: FigureWidget) {
    return other.kind === this.kind && other.source === this.source;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'zy-live-figure';
    const fig = document.createElement('div');
    fig.className = 'zy-figure';
    fig.setAttribute('role', 'img');
    fig.setAttribute('aria-label', this.source);
    if (this.kind === 'math') renderMath(fig, this.source, true);
    else void renderMermaid(fig, this.source);
    wrap.append(fig);
    revealOnMouseDown(wrap, view);
    return wrap;
  }
  get estimatedHeight() {
    return this.kind === 'math' ? 80 : 240;
  }
  ignoreEvent() {
    return true;
  }
}

/** YAML frontmatter 折叠成一行"属性 · N 项" */
export class FrontmatterWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(other: FrontmatterWidget) {
    return other.label === this.label;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'zy-live-frontmatter';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'zy-frontmatter-summary';
    btn.textContent = this.label;
    wrap.append(btn);
    revealOnMouseDown(wrap, view);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

// ---------- 行内（来自 ViewPlugin） ----------

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly resolveUrl?: ResolveUrl,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement('img');
    img.src = this.resolveUrl ? this.resolveUrl(this.src) : this.src;
    img.alt = this.alt;
    img.className = 'zy-live-img';
    return img;
  }
  ignoreEvent() {
    return false;
  }
}

export class InlineMathWidget extends WidgetType {
  constructor(readonly tex: string) {
    super();
  }
  eq(other: InlineMathWidget) {
    return other.tex === this.tex;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'inline-math';
    renderMath(span, this.tex, false);
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

export class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'zy-bullet';
    span.textContent = '•';
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

/** 任务列表的复选框，点击直接改源码里的 `[ ]` / `[x]` */
export class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'zy-task';
    box.checked = this.checked;
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const cur = view.state.sliceDoc(pos + 1, pos + 2);
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: cur === ' ' ? 'x' : ' ' }, userEvent: 'input' });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

export class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'zy-hr';
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

/** 代码块开头的围栏行：只显示语言名 */
export class FenceWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  eq(other: FenceWidget) {
    return other.lang === this.lang;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'zy-fence-lang';
    span.textContent = this.lang;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}
