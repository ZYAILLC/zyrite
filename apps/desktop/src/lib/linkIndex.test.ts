import { beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../store';
import { deps, openPath } from './document';
import { activeEditor, setActiveEditor } from './editorRef';
import { fakeBackend, resetStore } from './fakeBackend.testutil';
import { completeLinks, linkStatus, openAt, openIndex, openWikiLink } from './linkIndex';
import { refreshTree } from './vault';

let fake: ReturnType<typeof fakeBackend>;

beforeEach(async () => {
  resetStore();
  fake = fakeBackend();
  deps.backend = fake.b;
  fake.write('/v/docs/plan.md', 'P');
  fake.write('/v/notes/a.md', '第一行\n第二行 [[plan]]\n第三行');
  useApp.getState().setFolder('/v');
  await refreshTree();
  await openIndex();
  await openPath('/v/notes/a.md');
});

describe('双链', () => {
  it('判断存在与否；没打开库时无法判断', () => {
    expect(linkStatus('plan')).toBe('note');
    expect(linkStatus('新笔记')).toBe('missing');
    expect(linkStatus('图.png')).toBe('other');
    useApp.setState({ noteNames: null });
    expect(linkStatus('新笔记')).toBe('other');
  });

  it('点击存在的双链：打开', async () => {
    await openWikiLink('plan#定位');
    expect(useApp.getState().filePath).toBe('/v/docs/plan.md');
  });

  it('点击不存在的双链：在当前笔记的文件夹里创建并打开', async () => {
    await openWikiLink('新笔记');
    expect(fake.state.files.has('/v/notes/新笔记.md')).toBe(true);
    expect(useApp.getState().filePath).toBe('/v/notes/新笔记.md');
  });

  it('带路径的不存在双链：相对库根目录创建', async () => {
    await openWikiLink('docs/设计');
    expect(fake.state.files.has('/v/docs/设计.md')).toBe(true);
  });

  it('有未保存的修改时先问；取消就不创建', async () => {
    useApp.getState().setText('改了');
    useApp.getState().markEdited();
    fake.state.unsavedAnswer = 'cancel';
    await openWikiLink('新笔记');
    expect(fake.state.files.has('/v/notes/新笔记.md')).toBe(false);
  });
});

describe('openAt', () => {
  it('打开后等新编辑器建好，再跳到指定行', async () => {
    const revealed: number[] = [];
    const editor = (text: string) =>
      ({ getText: () => text, revealOffset: (o: number) => revealed.push(o) }) as unknown as NonNullable<
        typeof activeEditor.current
      >;
    const pending = openAt('/v/docs/plan.md', 0);
    await pending;
    // 模拟 Editor 组件为新文档建好编辑器
    setActiveEditor(editor('P'), useApp.getState().docId);
    expect(revealed).toEqual([0]);
    // 当前文件：直接跳
    await openAt('/v/notes/a.md', 2);
    setActiveEditor(editor('第一行\n第二行 [[plan]]\n第三行'), useApp.getState().docId);
    expect(revealed).toEqual([0, '第一行\n第二行 [[plan]]\n'.length]);
  });
});

describe('[[ 补全', () => {
  it('模糊匹配文件名和别名；重名插入路径', () => {
    useApp.setState({
      noteNames: [
        { rel: 'docs/plan.md', stem: 'plan', title: null, aliases: ['路线图'] },
        { rel: 'old/plan.md', stem: 'plan', title: null, aliases: [] },
        { rel: 'notes/a.md', stem: 'a', title: null, aliases: [] },
      ],
    });
    expect(completeLinks('pl').map((c) => c.insert)).toEqual(['docs/plan', 'old/plan']);
    expect(completeLinks('路线')).toEqual([{ label: '路线图', detail: 'plan', insert: 'docs/plan|路线图' }]);
  });

  it('没输入时最近打开的在前', () => {
    const r = completeLinks('');
    expect(r[0]?.label).toBe('a'); // notes/a.md 是刚打开的
  });
});
