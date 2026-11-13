/**
 * 输入 `[[` 时弹出的笔记补全，两种编辑器共用同一个菜单。
 * 弹出层样式：细边框 + 轻阴影，6px 圆角；选中项整行浅灰底（见 content.css 的 .zy-suggest）。
 */

export interface LinkSuggestion {
  /** 显示的名字（文件名或别名） */
  label: string;
  /** 右侧灰字：所在文件夹，或别名指向的笔记 */
  detail?: string;
  /** 插入到 `[[` 和 `]]` 之间的文字 */
  insert: string;
}

export type CompleteLinks = (query: string) => LinkSuggestion[];

/** 光标前是不是正在输入双链：返回 `[[` 之后已输入的文字和 `[[`（或 `![[`）的长度 */
export function matchLinkQuery(before: string): { query: string; open: number } | null {
  const m = /(!?)\[\[([^[\]|#\n]*)$/.exec(before);
  if (!m) return null;
  return { query: m[2] ?? '', open: (m[1] ? 3 : 2) + (m[2]?.length ?? 0) };
}

export class SuggestMenu {
  readonly dom: HTMLElement;
  private items: LinkSuggestion[] = [];
  private active = 0;

  constructor(private readonly onPick: (item: LinkSuggestion) => void) {
    this.dom = document.createElement('div');
    this.dom.className = 'zy-suggest';
    this.dom.setAttribute('role', 'listbox');
    this.dom.style.display = 'none';
    // 不抢编辑器的焦点
    this.dom.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.append(this.dom);
  }

  get isOpen(): boolean {
    return this.dom.style.display !== 'none';
  }

  /** 显示在光标下方；没有候选就关闭 */
  show(items: LinkSuggestion[], at: { left: number; bottom: number; top: number }) {
    if (!items.length) {
      this.close();
      return;
    }
    const same = items.length === this.items.length && items.every((it, i) => it.insert === this.items[i]?.insert);
    this.items = items;
    if (!same) this.active = 0;
    this.render();
    this.dom.style.display = '';
    // 下方放不下时放到光标上方
    const h = this.dom.offsetHeight;
    const top = at.bottom + 4 + h > window.innerHeight - 8 ? at.top - 4 - h : at.bottom + 4;
    this.dom.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - this.dom.offsetWidth - 8))}px`;
    this.dom.style.top = `${Math.max(8, top)}px`;
  }

  close() {
    this.dom.style.display = 'none';
    this.items = [];
  }

  /** 编辑器按键：返回 true 表示已处理 */
  handleKey(key: string): boolean {
    if (!this.isOpen) return false;
    if (key === 'ArrowDown') this.active = (this.active + 1) % this.items.length;
    else if (key === 'ArrowUp') this.active = (this.active - 1 + this.items.length) % this.items.length;
    else if (key === 'Enter' || key === 'Tab') {
      const item = this.items[this.active];
      this.close();
      if (item) this.onPick(item);
      return true;
    } else if (key === 'Escape') {
      this.close();
      return true;
    } else return false;
    this.render();
    return true;
  }

  destroy() {
    this.dom.remove();
  }

  private render() {
    this.dom.replaceChildren(
      ...this.items.map((item, i) => {
        const row = document.createElement('div');
        row.className = 'zy-suggest-item';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === this.active));
        const label = document.createElement('span');
        label.textContent = item.label;
        row.append(label);
        if (item.detail) {
          const detail = document.createElement('span');
          detail.className = 'zy-suggest-detail';
          detail.textContent = item.detail;
          row.append(detail);
        }
        row.addEventListener('mouseenter', () => {
          if (this.active !== i) {
            this.active = i;
            this.render();
          }
        });
        row.addEventListener('click', () => {
          this.close();
          this.onPick(item);
        });
        return row;
      }),
    );
    this.dom.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }
}
