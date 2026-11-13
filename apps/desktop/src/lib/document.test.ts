import { beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../store';
import { activeEditor } from './editorRef';
import { fakeBackend, resetStore } from './fakeBackend.testutil';
import {
  deps,
  dropFiles,
  ensureSaved,
  newDoc,
  openFolder,
  openLink,
  openPath,
  prepareClose,
  quickOpenRoot,
  restoreSession,
  save,
  saveAs,
} from './document';

let fake: ReturnType<typeof fakeBackend>;

/** 模拟在编辑器里输入（没有编辑器实例时，document.ts 读 store 里的 text） */
function type(text: string) {
  useApp.getState().setText(text);
  useApp.getState().markEdited();
}

beforeEach(() => {
  activeEditor.current = null;
  activeEditor.docId = -1;
  fake = fakeBackend();
  deps.backend = fake.b;
  resetStore();
});

describe('打开和保存', () => {
  it('打开文件，编辑后保存；恢复缓存里不留内容', async () => {
    fake.write('/d/a.md', '# A\r\n');
    expect(await openPath('/d/a.md')).toBe(true);
    expect(useApp.getState()).toMatchObject({ filePath: '/d/a.md', text: '# A\r\n', dirty: false, docId: 1 });
    expect(fake.state.session).toMatchObject({ path: '/d/a.md', text: null });

    type('# A\r\nmore\r\n');
    expect(useApp.getState().dirty).toBe(true);
    expect(await save()).toBe(true);
    expect(fake.state.files.get('/d/a.md')?.text).toBe('# A\r\nmore\r\n');
    expect(useApp.getState()).toMatchObject({ dirty: false, savedText: '# A\r\nmore\r\n' });
    expect(useApp.getState().notice?.text).toBeTruthy();
    expect(fake.state.session?.text).toBeNull();
  });

  it('打开后、新编辑器建好前：不把旧编辑器的内容当成未保存修改', async () => {
    // 旧编辑器（docId 0）里是空文档
    activeEditor.current = { getText: () => '' } as unknown as typeof activeEditor.current;
    activeEditor.docId = 0;
    fake.write('/d/a.md', 'content');
    await openPath('/d/a.md');
    expect(fake.state.session).toMatchObject({ path: '/d/a.md', text: null });
    expect(await ensureSaved()).toBe(true);
    expect(fake.state.asked).toEqual([]);
  });

  it('新文档保存走另存为；取消另存为就什么都不做', async () => {
    type('hello');
    fake.state.savePick = null;
    expect(await save()).toBe(false);
    expect(useApp.getState().filePath).toBeNull();
    fake.state.savePick = '/d/new.md';
    expect(await save()).toBe(true);
    expect(useApp.getState()).toMatchObject({ filePath: '/d/new.md', dirty: false });
    expect(fake.state.files.get('/d/new.md')?.text).toBe('hello');
  });

  it('另存为到别的路径：无条件写入，之后的保存都写新文件', async () => {
    fake.write('/d/a.md', 'A');
    await openPath('/d/a.md');
    fake.write('/d/copy.md', 'old copy');
    type('A2');
    fake.state.savePick = '/d/copy.md';
    expect(await saveAs()).toBe(true);
    expect(fake.state.files.get('/d/copy.md')?.text).toBe('A2');
    expect(fake.state.files.get('/d/a.md')?.text).toBe('A');
    type('A3');
    expect(await save()).toBe(true);
    expect(fake.state.files.get('/d/copy.md')?.text).toBe('A3');
  });

  it('打开不存在的文件：弹出错误，当前文档不变', async () => {
    expect(await openPath('/nope.md')).toBe(false);
    expect(fake.state.errors).toHaveLength(1);
    expect(useApp.getState().docId).toBe(0);
  });
});

describe('外部修改（例如 Agent 写入）', () => {
  beforeEach(async () => {
    fake.write('/d/a.md', 'v1');
    await openPath('/d/a.md');
    fake.write('/d/a.md', 'agent');
    type('mine');
  });

  it('取消：不写入', async () => {
    fake.state.conflictAnswer = 'cancel';
    expect(await save()).toBe(false);
    expect(fake.state.asked).toEqual(['conflict:a.md']);
    expect(fake.state.files.get('/d/a.md')?.text).toBe('agent');
    expect(useApp.getState().dirty).toBe(true);
  });

  it('覆盖：写入我的版本', async () => {
    fake.state.conflictAnswer = 'overwrite';
    expect(await save()).toBe(true);
    expect(fake.state.files.get('/d/a.md')?.text).toBe('mine');
  });

  it('重新载入：读取磁盘上的版本', async () => {
    fake.state.conflictAnswer = 'reload';
    expect(await save()).toBe(false);
    expect(useApp.getState()).toMatchObject({ text: 'agent', dirty: false });
  });
});

describe('未保存的修改', () => {
  it('没有修改不问；有修改按用户选择', async () => {
    expect(await ensureSaved()).toBe(true);
    type('x');
    fake.state.unsavedAnswer = 'cancel';
    expect(await newDoc()).toBe(false);
    expect(useApp.getState().text).toBe('x');
    fake.state.unsavedAnswer = 'discard';
    expect(await newDoc()).toBe(true);
    expect(useApp.getState()).toMatchObject({ text: '', dirty: false });
    expect(fake.state.asked).toHaveLength(2);
    expect(fake.state.asked.every((a) => a.startsWith('unsaved:'))).toBe(true);
  });

  it('关窗选"不保存"：恢复缓存清掉内容', async () => {
    fake.write('/d/a.md', 'v1');
    await openPath('/d/a.md');
    type('changed');
    fake.state.session = { path: '/d/a.md', text: 'changed', stamp: null, updatedMs: 0 };
    fake.state.unsavedAnswer = 'discard';
    expect(await prepareClose()).toBe(true);
    expect(fake.state.session).toMatchObject({ path: '/d/a.md', text: null });
  });

  it('关窗选"取消"：不关', async () => {
    type('changed');
    fake.state.unsavedAnswer = 'cancel';
    expect(await prepareClose()).toBe(false);
  });
});

describe('启动还原', () => {
  it('有未保存内容：还原并标为未保存，保留打开时的戳', async () => {
    const stamp = fake.write('/d/a.md', 'disk');
    fake.state.session = { path: '/d/a.md', text: 'unsaved', stamp, updatedMs: 0 };
    await restoreSession();
    expect(useApp.getState()).toMatchObject({ filePath: '/d/a.md', text: 'unsaved', savedText: 'disk', dirty: true, stamp });
  });

  it('没有未保存内容：重新打开上次的文件；文件没了就保持空白', async () => {
    fake.write('/d/a.md', 'disk');
    fake.state.session = { path: '/d/a.md', text: null, stamp: null, updatedMs: 0 };
    await restoreSession();
    expect(useApp.getState()).toMatchObject({ filePath: '/d/a.md', text: 'disk', dirty: false });

    useApp.setState({ filePath: null, text: '', savedText: '' });
    fake.state.session = { path: '/gone.md', text: null, stamp: null, updatedMs: 0 };
    await restoreSession();
    expect(useApp.getState().filePath).toBeNull();
    expect(fake.state.errors).toHaveLength(0);
  });

  it('命令行传入的文件：先还原，再按未保存规则打开', async () => {
    fake.write('/d/b.md', 'B');
    fake.state.session = { path: null, text: 'draft', stamp: null, updatedMs: 0 };
    fake.state.launch = '/d/b.md';
    fake.state.unsavedAnswer = 'cancel';
    await restoreSession();
    // 用户取消：草稿还在
    expect(useApp.getState()).toMatchObject({ filePath: null, text: 'draft', dirty: true });
  });
});

describe('链接', () => {
  beforeEach(async () => {
    fake.write('/d/a.md', 'A');
    fake.write('/d/sub/b.md', 'B');
    fake.write('/d/笔记.md', 'N');
    await openPath('/d/a.md');
  });

  it('网址交给系统浏览器', async () => {
    await openLink('https://z-y.ai', 'url');
    expect(fake.state.opened).toEqual(['https://z-y.ai']);
  });

  it('相对路径的 md 和双链在应用里打开', async () => {
    await openLink('sub/b.md#标题', 'url');
    expect(useApp.getState().filePath).toBe('/d/sub/b.md');
    await openLink('../笔记', 'wikilink');
    expect(useApp.getState().filePath).toBe('/d/笔记.md');
  });

  it('不存在的链接只在状态栏提示', async () => {
    await openLink('nope.md', 'url');
    expect(fake.state.errors).toHaveLength(0);
    expect(useApp.getState().notice?.error).toBe(true);
  });
});

describe('文件夹和最近打开', () => {
  it('打开文件夹：记进会话，并弹出快速打开；启动时还原', async () => {
    fake.state.folderPick = '/vault';
    expect(await openFolder()).toBe(true);
    expect(useApp.getState()).toMatchObject({ folder: '/vault', palette: { mode: 'files' } });
    expect(fake.state.session?.folder).toBe('/vault');
    expect(quickOpenRoot()).toBe('/vault');

    useApp.setState({ folder: null });
    await restoreSession();
    expect(useApp.getState().folder).toBe('/vault');
  });

  it('没打开文件夹时，快速打开的范围是当前文件所在目录', async () => {
    expect(quickOpenRoot()).toBeNull();
    fake.write('/d/a.md', 'A');
    await openPath('/d/a.md');
    expect(quickOpenRoot()).toBe('/d');
  });

  it('打开和另存为都记进最近打开，最新的在前、不重复', async () => {
    fake.write('/d/a.md', 'A');
    fake.write('/d/b.md', 'B');
    await openPath('/d/a.md');
    await openPath('/d/b.md');
    await openPath('/d/a.md');
    fake.state.savePick = '/d/c.md';
    await saveAs();
    expect(useApp.getState().recent).toEqual(['/d/c.md', '/d/a.md', '/d/b.md']);
  });
});

describe('拖入文件', () => {
  it('在落点插入相对路径链接，并放行图片目录', async () => {
    fake.write('/d/note.md', 'N');
    await openPath('/d/note.md');
    const inserted: { md: string; at?: { x: number; y: number } }[] = [];
    activeEditor.current = {
      getText: () => 'N',
      insertMarkdown: (md: string, at?: { x: number; y: number }) => inserted.push({ md, at }),
    } as unknown as typeof activeEditor.current;
    activeEditor.docId = useApp.getState().docId;
    await dropFiles(['/d/img/a b.png', '/e/spec.pdf'], { x: 10, y: 20 });
    expect(inserted).toEqual([{ md: '![a b](img/a%20b.png)\n[spec.pdf](../e/spec.pdf)', at: { x: 10, y: 20 } }]);
    expect(fake.state.allowed).toEqual(['/d/img/a b.png', '/e/spec.pdf']);
  });

  it('拖入 Markdown 文件直接打开，不插链接', async () => {
    fake.write('/d/note.md', 'N');
    fake.write('/e/spec.md', 'S');
    await openPath('/d/note.md');
    await dropFiles(['/d/img/a.png', '/e/spec.md']);
    expect(useApp.getState().filePath).toBe('/e/spec.md');
    expect(useApp.getState().text).toBe('S');
  });

  it('拖入文件夹当作库打开', async () => {
    fake.write('/vault/a.md', 'A');
    await dropFiles(['/vault']);
    expect(useApp.getState().folder).toBe('/vault');
  });
});
