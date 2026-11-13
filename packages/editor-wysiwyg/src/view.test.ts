// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createWysiwygEditor } from './view';

// jsdom 没有排版，ProseMirror 量坐标时要用到的接口补成空的
Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
Element.prototype.scrollIntoView = () => {};

const parents: HTMLElement[] = [];
function mount(source: string) {
  const parent = document.createElement('div');
  document.body.append(parent);
  parents.push(parent);
  return createWysiwygEditor({ parent, source });
}
afterEach(() => {
  for (const p of parents.splice(0)) p.remove();
});

describe('表情、上下标', () => {
  it('表情显示成字符，上标用 <sup>；保存逐字节不变', () => {
    const src = 'Go :rocket: x^2^ H~2~O\n';
    const ed = mount(src);
    const dom = parents[0]!;
    const emoji = dom.querySelector('.emoji') as HTMLElement;
    expect(emoji.textContent).toBe('🚀');
    expect(emoji.title).toBe(':rocket:');
    expect(dom.querySelector('sup')?.textContent).toBe('2');
    expect(dom.querySelector('del')?.textContent).toBe('2');
    expect(ed.getText()).toBe(src);
  });
});

describe('insertMarkdown', () => {
  it('在光标处插入图片：保存出来是 Markdown，不是转义后的文字', () => {
    const ed = mount('# 标题\n\n第一段\n');
    ed.setCursorBlock(1);
    ed.insertMarkdown('![logo](img/logo%20a.png)');
    expect(ed.getText()).toBe('# 标题\n\n![logo](img/logo%20a.png)第一段\n');
  });

  it('其他块逐字节不变', () => {
    const src = '* 列表用星号\n\n第一段\n\n```js\nx\n```\n';
    const ed = mount(src);
    ed.setCursorBlock(1);
    ed.insertMarkdown('[文档](docs/a.md)');
    expect(ed.getText()).toBe('* 列表用星号\n\n[文档](docs/a.md)第一段\n\n```js\nx\n```\n');
  });
});

describe('不存在的双链', () => {
  it('加 missing 类；refreshLinks 重新判断', () => {
    const existing = new Set(['有']);
    const parent = document.createElement('div');
    document.body.append(parent);
    parents.push(parent);
    const ed = createWysiwygEditor({
      parent,
      source: '[[有]] 和 [[没有|别名]]\n',
      linkStatus: (t) => (existing.has(t) ? 'note' : 'missing'),
    });
    expect([...parent.querySelectorAll('.wikilink.missing')].map((e) => e.textContent)).toEqual(['别名']);
    existing.add('没有');
    ed.refreshLinks();
    expect(parent.querySelectorAll('.wikilink.missing')).toHaveLength(0);
  });
});

describe('[[ 补全', () => {
  it('输入 [[ 弹出候选，↵ 插入双链节点', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    parents.push(parent);
    const ed = createWysiwygEditor({
      parent,
      source: '见\n',
      completeLinks: () => [{ label: '方案', insert: 'zyrite-方案' }],
    });
    const pm = parent.querySelector<HTMLElement>('.ProseMirror')!;
    // jsdom 里 contenteditable 不能获得焦点，加 tabindex 让它能
    pm.tabIndex = 0;
    ed.setCursorBlock(0);
    // 在光标处输入 [[方（光标在段落开头，所以结果是 [[zyrite-方案]]见）
    ed.insertMarkdown('[[方');
    const menu = document.querySelector<HTMLElement>('.zy-suggest');
    expect(menu?.style.display).toBe('');
    pm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    expect(ed.getText()).toMatch(/\[\[zyrite-方案\]\]/);
    expect(ed.getText()).not.toContain('[[方');
  });
});

describe('批注和选区', () => {
  it('在摊平的文字里定位批注，读选区，替换和插入', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    parents.push(parent);
    const ed = createWysiwygEditor({ parent, source: '第一段 **粗体**。\n\n这一句要改。\n' });
    ed.setAnnotations([{ id: 'a', n: 2, anchor: { text: '要改', prefix: '这一句', suffix: '。' }, resolved: false }]);
    expect(parent.querySelector('.zy-ann')?.textContent).toBe('要改');
    expect(parent.querySelector('.zy-ann-n')?.textContent).toBe('2');
    ed.setCursorBlock(0);
    expect(ed.getSelectionInfo()).toBeNull();
    ed.replaceSelection('开头。', true);
    expect(ed.getText()).toBe('第一段 **粗体**。\n\n开头。\n\n这一句要改。\n');
  });
});
