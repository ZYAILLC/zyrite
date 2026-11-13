// @vitest-environment jsdom
import { Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { loadCorpus } from '@zyrite/md-blocks/corpus';
import { splitBlocks } from '@zyrite/md-blocks';
import { afterEach, describe, expect, it } from 'vitest';
import { setFocused } from './active';
import { detectEol, offsetToPos, posToOffset } from './eol';
import { createLiveEditor } from './view';

// jsdom 没有排版，CodeMirror 量尺寸时要用到的接口补成空的
Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const corpus = loadCorpus();
const parents: HTMLElement[] = [];

function mount(source: string) {
  const parent = document.createElement('div');
  document.body.append(parent);
  parents.push(parent);
  const editor = createLiveEditor({ parent, source });
  return { editor, parent };
}

/** 取到内部的 EditorView（测试用） */
function cmView(parent: HTMLElement): EditorView {
  return EditorView.findFromDOM(parent.querySelector('.cm-editor') as HTMLElement)!;
}

afterEach(() => {
  for (const p of parents.splice(0)) p.remove();
});

describe('eol', () => {
  it('按第一个换行判断', () => {
    expect(detectEol('a\r\nb\nc')).toBe('\r\n');
    expect(detectEol('a\nb\r\n')).toBe('\n');
    expect(detectEol('')).toBe('\n');
  });

  it('CRLF 下位置和偏移互转', () => {
    const source = 'ab\r\ncd\r\n\r\nef';
    const doc = Text.of(source.split('\r\n'));
    for (let pos = 0; pos <= doc.length; pos++) {
      const offset = posToOffset(doc, pos, '\r\n');
      expect(offsetToPos(doc, offset, '\r\n')).toBe(pos);
    }
    expect(posToOffset(doc, doc.line(2).from, '\r\n')).toBe(source.indexOf('cd'));
    expect(offsetToPos(doc, source.indexOf('ef'), '\r\n')).toBe(doc.line(4).from);
    // 落在 \r\n 中间算行尾
    expect(offsetToPos(doc, 3, '\r\n')).toBe(2);
  });
});

describe.each(corpus.map((c) => [c.name, c.source] as const))('%s', (_name, source) => {
  it('不编辑直接取文本：逐字节一致', () => {
    const { editor } = mount(source);
    expect(editor.getText()).toBe(source);
    editor.destroy();
  });

  it('在第二行开头插一个字：只多这一个字', () => {
    const { editor, parent } = mount(source);
    const view = cmView(parent);
    if (view.state.doc.lines < 2) return;
    const pos = view.state.doc.line(2).from;
    view.dispatch({ changes: { from: pos, insert: '字' } });
    const offset = posToOffset(view.state.doc, pos, detectEol(source));
    expect(editor.getText()).toBe(source.slice(0, offset) + '字' + source.slice(offset));
    editor.destroy();
  });

  it('光标块序号：设置后读回一致', () => {
    const { editor } = mount(source);
    const n = splitBlocks(source).blocks.length;
    // 每次都要整篇解析，长文档只抽查一部分块
    const step = Math.max(1, Math.floor(n / 12));
    for (let i = 0; i < n; i += step) {
      editor.setCursorBlock(i);
      expect(editor.getCursorBlock()).toBe(i);
    }
    editor.destroy();
  });
});

describe('实时预览', () => {
  const source = '# 标题\n\n这是 **粗体** 和 [链接](https://a.b) 还有 [[笔记|别名]]。\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';

  it('没有焦点时全部渲染：标记隐藏，表格换成 <table>', () => {
    const { parent } = mount(source);
    const content = parent.querySelector('.cm-content')!;
    const text = content.textContent ?? '';
    expect(text).toContain('标题');
    expect(text).not.toContain('# ');
    expect(text).not.toContain('**');
    expect(text).not.toContain('](https://a.b)');
    expect(text).not.toContain('[[');
    expect(text).toContain('别名');
    expect(content.querySelector('table')).not.toBeNull();
    expect(content.querySelector('.zy-h1')).not.toBeNull();
  });

  it('光标所在块显示标记，其他块照常渲染', () => {
    const { parent } = mount(source);
    const view = cmView(parent);
    const para = source.indexOf('这是');
    view.dispatch({ selection: { anchor: para }, effects: setFocused.of(true) });
    const text = parent.querySelector('.cm-content')!.textContent ?? '';
    expect(text).toContain('**粗体**');
    expect(text).toContain('[[笔记|别名]]');
    expect(text).not.toContain('# 标题');
    expect(parent.querySelector('.cm-content table')).not.toBeNull();

    // 光标进表格：表格显示源码
    view.dispatch({ selection: { anchor: source.indexOf('| a') } });
    expect(parent.querySelector('.cm-content table')).toBeNull();
    expect(parent.querySelector('.cm-content')!.textContent).toContain('|---|---|');
  });
});

describe('[[ 补全', () => {
  it('输入 [[ 弹出候选，↵ 插入并跳过自动配对的 ]]', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    parents.push(parent);
    const queries: string[] = [];
    const editor = createLiveEditor({
      parent,
      source: '见 \n',
      completeLinks: (q) => {
        queries.push(q);
        return [{ label: 'plan', detail: 'docs', insert: 'docs/plan' }];
      },
    });
    const view = cmView(parent);
    // jsdom 没有排版：给光标一个假坐标，并让文档处于有焦点状态
    view.coordsAtPos = () => ({ left: 10, right: 10, top: 10, bottom: 20 });
    document.hasFocus = () => true;
    view.focus();
    // 模拟自动配对后的状态：见 [[pl|]]
    view.dispatch({ changes: { from: 2, insert: '[[pl]]' }, selection: { anchor: 6 } });
    await new Promise((r) => setTimeout(r, 50));
    const menu = document.querySelector<HTMLElement>('.zy-suggest');
    expect(menu?.style.display).toBe('');
    expect(menu?.textContent).toContain('plan');
    expect(queries.at(-1)).toBe('pl');
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    expect(editor.getText()).toBe('见 [[docs/plan]]\n');
    expect(view.state.selection.main.head).toBe('见 [[docs/plan]]'.length);
    expect(menu?.style.display).toBe('none');
    editor.destroy();
    expect(document.querySelector('.zy-suggest')).toBeNull();
  });
});

describe('不存在的双链', () => {
  it('显示成虚线；库里的笔记变了之后 refreshLinks 重新判断', () => {
    const existing = new Set(['有']);
    const parent = document.createElement('div');
    document.body.append(parent);
    parents.push(parent);
    const editor = createLiveEditor({
      parent,
      source: '[[有]] 和 [[没有|别名]]\n',
      linkStatus: (t) => (existing.has(t) ? 'note' : 'missing'),
    });
    expect([...parent.querySelectorAll('.zy-link-missing')].map((e) => e.textContent)).toEqual(['别名']);
    existing.add('没有');
    editor.refreshLinks();
    expect(parent.querySelectorAll('.zy-link-missing')).toHaveLength(0);
  });
});

describe('批注和选区', () => {
  it('标出批注、读选区、替换和插入', () => {
    const { editor, parent } = mount('第一段。\n\n这一句要改。\n');
    // jsdom 没有排版，给坐标一个假值
    cmView(parent).coordsAtPos = () => ({ left: 1, right: 2, top: 3, bottom: 4 });
    editor.setAnnotations([{ id: 'a', n: 1, anchor: { text: '要改', prefix: '这一句', suffix: '。' }, resolved: false }]);
    expect(parent.querySelector('.zy-ann')?.textContent).toBe('要改');
    expect(parent.querySelector('.zy-ann-n')?.textContent).toBe('1');
    expect(Object.keys(editor.annotationTops())).toEqual(['a']);
    const view = cmView(parent);
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    expect(editor.getSelectionInfo()?.rect).toEqual({ left: 1, top: 3, right: 2, bottom: 4 });
    expect(editor.getSelectionInfo()).toMatchObject({ text: '第一段', prefix: '', suffix: '。\n\n这一句要改。\n' });
    editor.replaceSelection('首段');
    expect(editor.getText()).toBe('首段。\n\n这一句要改。\n');
    view.dispatch({ selection: { anchor: 0, head: 2 } });
    editor.replaceSelection('补充一段。', true);
    expect(editor.getText()).toBe('首段。\n\n补充一段。\n\n这一句要改。\n');
    // 改了原文，批注跟着走
    expect(parent.querySelector('.zy-ann')?.textContent).toBe('要改');
  });
});

describe('脚注', () => {
  it('没有焦点时：引用显示为编号，定义行显示标签，源码标记隐藏', () => {
    const { parent, editor } = mount('正文[^1]，再引[^note]。\n\n[^1]: 第一条说明\n[^note]: 第二条\n');
    const text = parent.querySelector('.cm-content')!.textContent ?? '';
    expect(text).toContain('正文1，再引note。');
    expect(text).toContain('1 第一条说明');
    expect(text).not.toContain('[^');
    expect(parent.querySelectorAll('.zy-fnref')).toHaveLength(2);
    expect(parent.querySelectorAll('.zy-fndef')).toHaveLength(2);
    expect(editor.getText()).toContain('[^note]: 第二条');
  });
});

describe('insertMarkdown', () => {
  it('在光标处插入，光标移到后面', () => {
    const { editor, parent } = mount('ab\r\ncd\r\n');
    const view = cmView(parent);
    view.dispatch({ selection: { anchor: 1 } });
    editor.insertMarkdown('![x](y.png)');
    expect(editor.getText()).toBe('a![x](y.png)b\r\ncd\r\n');
    expect(view.state.selection.main.head).toBe(1 + '![x](y.png)'.length);
  });
});

describe('引用式链接', () => {
  it('没有定义的 [文字] 按普通文字显示，定义过的才隐藏括号', () => {
    const { parent } = mount('> [!note] 提示\n\n见 [1] 和 [文档][d]。\n\n[d]: https://a.b\n');
    const text = parent.querySelector('.cm-content')!.textContent ?? '';
    expect(text).toContain('[!note]');
    expect(text).toContain('[1]');
    expect(text).not.toContain('[文档]');
    expect(text).toContain('文档');
  });
});

describe('查找替换', () => {
  it('计数、跳转、全部替换', () => {
    const { editor } = mount('foo bar foo\nFoo');
    const q = { search: 'foo', replace: 'baz', caseSensitive: false, regexp: false };
    expect(editor.find.setQuery(q).count).toBe(3);
    expect(editor.find.next()).toEqual({ count: 3, current: 1 });
    expect(editor.find.next()).toEqual({ count: 3, current: 2 });
    expect(editor.find.setQuery({ ...q, caseSensitive: true }).count).toBe(2);
    expect(editor.find.replaceAll()).toBe(2);
    expect(editor.getText()).toBe('baz bar baz\nFoo');
    editor.find.close();
  });

  it('正则替换支持分组', () => {
    const { editor } = mount('a1 b2');
    editor.find.setQuery({ search: '([a-z])(\\d)', replace: '$2$1', caseSensitive: true, regexp: true });
    expect(editor.find.replaceAll()).toBe(2);
    expect(editor.getText()).toBe('1a 2b');
  });
});
