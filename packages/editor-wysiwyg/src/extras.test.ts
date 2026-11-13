// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createWysiwygEditor } from './view';

Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
Element.prototype.scrollIntoView = () => {};

const parents: HTMLElement[] = [];
function mount(source: string) {
  const parent = document.createElement('div');
  document.body.append(parent);
  parents.push(parent);
  return { ed: createWysiwygEditor({ parent, source }), parent };
}
afterEach(() => {
  for (const p of parents.splice(0)) p.remove();
});

/** 用查找选中一段文字 */
function select(ed: ReturnType<typeof createWysiwygEditor>, text: string) {
  ed.find.setQuery({ search: text, replace: '', caseSensitive: true, regexp: false });
  ed.find.next();
}

describe('wrapSelection（文字颜色）', () => {
  it('选中的文字前后加上 HTML 标签，其他块不变', () => {
    const { ed } = mount('# Title\n\nsome **bold** words\n\nlast\n');
    select(ed, 'bold');
    expect(ed.wrapSelection?.('<span style="color:#E5484D">', '</span>')).toBe(true);
    expect(ed.getText()).toBe('# Title\n\nsome **<span style="color:#E5484D">bold</span>** words\n\nlast\n');
  });

  it('没有选中文字时不处理', () => {
    const { ed } = mount('text\n');
    expect(ed.wrapSelection?.('<u>', '</u>')).toBe(false);
    expect(ed.getText()).toBe('text\n');
  });
});

describe('色块和目录', () => {
  it('行内代码是颜色值时后面有色块，别的代码没有', () => {
    const { parent } = mount('a `#E0A040` b `npm i` c\n');
    expect(parent.querySelectorAll('.zy-swatch')).toHaveLength(1);
  });

  it('[TOC] 显示全文标题，原文不变', () => {
    const src = '[TOC]\n\n# One\n\n## Two\n\ntext\n';
    const { ed, parent } = mount(src);
    const links = [...parent.querySelectorAll('.zy-toc-link')].map((a) => a.textContent);
    expect(links).toEqual(['One', 'Two']);
    expect(parent.querySelector('p.zy-toc-marker')?.textContent).toBe('[TOC]');
    expect(ed.getText()).toBe(src);
  });
});
