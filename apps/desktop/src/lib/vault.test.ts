import { beforeEach, describe, expect, it } from 'vitest';
import { buildTree } from '../components/FileTree';
import { t } from '../i18n';
import { useApp } from '../store';
import { deps, openPath, save } from './document';
import { activeEditor } from './editorRef';
import { fakeBackend, resetStore } from './fakeBackend.testutil';
import {
  handleFsChanges,
  moveEntry,
  newFolder,
  newNote,
  refreshTree,
  renameEntry,
  trashEntry,
  updateWatch,
  watchSpecs,
} from './vault';

let fake: ReturnType<typeof fakeBackend>;

/** handleFsChanges 里的处理是异步的，等它跑完 */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 等到条件成立（最多 1 秒） */
async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

function type(text: string) {
  useApp.getState().setText(text);
  useApp.getState().markEdited();
}

beforeEach(async () => {
  resetStore();
  fake = fakeBackend();
  deps.backend = fake.b;
  fake.write('/v/a.md', 'A');
  fake.write('/v/docs/plan.md', 'P');
  fake.write('/v/docs/img/x.png', '');
  useApp.getState().setFolder('/v');
  await refreshTree();
});

describe('文件树', () => {
  it('文件夹在前，自然排序', () => {
    const nodes = buildTree([
      { path: 'b.md', dir: false },
      { path: 'note 10.md', dir: false },
      { path: 'note 2.md', dir: false },
      { path: 'z', dir: true },
      { path: 'z/in.md', dir: false },
      { path: 'a', dir: true },
    ]);
    expect(nodes.map((n) => n.name)).toEqual(['a', 'z', 'b.md', 'note 2.md', 'note 10.md']);
    expect(nodes[1]?.children.map((n) => n.name)).toEqual(['in.md']);
  });

  it('列出库里的文件', () => {
    expect(useApp.getState().tree?.map((e) => e.path)).toEqual(['a.md', 'docs', 'docs/img', 'docs/img/x.png', 'docs/plan.md']);
  });
});

describe('文件操作', () => {
  it('新建笔记：不重名、打开、进入改名、上级文件夹展开', async () => {
    fake.write(`/v/docs/${t.untitledNote}.md`, '');
    await refreshTree();
    await newNote('/v/docs');
    const path = `/v/docs/${t.untitledNote} 1.md`;
    const s = useApp.getState();
    expect(s.filePath).toBe(path);
    expect(s.renaming).toBe(path);
    expect(s.expanded.docs).toBe(true);
    expect(fake.state.files.has(path)).toBe(true);
  });

  it('新建笔记前先处理未保存的修改；取消就不建', async () => {
    type('draft');
    fake.state.unsavedAnswer = 'cancel';
    await newNote('/v');
    expect([...fake.state.files.keys()].some((p) => p.includes(t.untitledNote))).toBe(false);
  });

  it('新建文件夹', async () => {
    await newFolder('/v/docs');
    expect(useApp.getState().tree?.some((e) => e.dir && e.path === `docs/${t.untitledFolder}`)).toBe(true);
    expect(useApp.getState().renaming).toBe(`/v/docs/${t.untitledFolder}`);
  });

  it('改名当前文件：路径、最近打开同步；没写扩展名自动补 .md', async () => {
    await openPath('/v/docs/plan.md');
    expect(await renameEntry('/v/docs/plan.md', '方案')).toBe(true);
    expect(useApp.getState().filePath).toBe('/v/docs/方案.md');
    expect(useApp.getState().recent[0]).toBe('/v/docs/方案.md');
    expect(fake.state.session?.path).toBe('/v/docs/方案.md');
  });

  it('改名文件夹：里面的当前文件和展开状态跟着变', async () => {
    await openPath('/v/docs/plan.md');
    useApp.getState().setExpanded('docs/img', true);
    expect(await renameEntry('/v/docs', 'notes')).toBe(true);
    expect(useApp.getState().filePath).toBe('/v/notes/plan.md');
    expect(useApp.getState().expanded['notes/img']).toBe(true);
  });

  it('非法名字和重名：提示，不改', async () => {
    expect(await renameEntry('/v/a.md', 'x/y')).toBe(false);
    expect(useApp.getState().notice?.error).toBe(true);
    expect(await renameEntry('/v/a.md', 'plan.md')).toBe(true); // 不同目录不冲突
    // 没写扩展名的自动补 .md，所以 "docs" 变成 docs.md，不和文件夹 docs 冲突
    expect(await renameEntry('/v/plan.md', 'docs')).toBe(true);
    fake.write('/v/b.md', 'B');
    expect(await renameEntry('/v/docs.md', 'b.md')).toBe(false); // 真重名
    expect(fake.state.files.has('/v/docs.md')).toBe(true);
    expect(fake.state.files.get('/v/b.md')?.text).toBe('B');
  });

  it('有链接指向它：问要不要更新；更新、不更新、取消', async () => {
    fake.state.linkCounts['/v/docs/plan.md'] = 3;
    fake.state.linkUpdated['/v/docs/plan.md'] = ['/v/a.md'];
    expect(await renameEntry('/v/docs/plan.md', 'roadmap')).toBe(true);
    expect(fake.state.asked).toContain('links:plan.md:3');
    expect(fake.state.renames.at(-1)).toEqual({ from: '/v/docs/plan.md', to: '/v/docs/roadmap.md', updateLinks: true });
    expect(useApp.getState().notice?.text).toBe(t.linksUpdated(1));

    fake.state.linkCounts['/v/docs/roadmap.md'] = 3;
    fake.state.updateLinksAnswer = 'skip';
    expect(await renameEntry('/v/docs/roadmap.md', 'plan')).toBe(true);
    expect(fake.state.renames.at(-1)?.updateLinks).toBe(false);

    fake.state.linkCounts['/v/docs/plan.md'] = 3;
    fake.state.updateLinksAnswer = 'cancel';
    expect(await renameEntry('/v/docs/plan.md', 'x')).toBe(false);
    expect(fake.state.files.has('/v/docs/plan.md')).toBe(true);
  });

  it('拖到别的文件夹', async () => {
    await openPath('/v/a.md');
    expect(await moveEntry('/v/a.md', '/v/docs')).toBe(true);
    expect(useApp.getState().filePath).toBe('/v/docs/a.md');
    expect(fake.state.files.has('/v/docs/a.md')).toBe(true);
  });

  it('删除当前文件：确认后进回收站，换成空白文档；取消就不删', async () => {
    await openPath('/v/a.md');
    fake.state.trashAnswer = false;
    expect(await trashEntry('/v/a.md')).toBe(false);
    expect(fake.state.files.has('/v/a.md')).toBe(true);
    fake.state.trashAnswer = true;
    expect(await trashEntry('/v/a.md')).toBe(true);
    expect(fake.state.files.has('/v/a.md')).toBe(false);
    expect(useApp.getState()).toMatchObject({ filePath: null, text: '' });
    expect(useApp.getState().recent).not.toContain('/v/a.md');
  });
});

describe('文件监听', () => {
  it('监听范围：库递归；库外的文件只监听它的目录', async () => {
    expect(watchSpecs('/v', '/v/a.md')).toEqual([{ path: '/v', recursive: true }]);
    expect(watchSpecs('/v', '/other/b.md')).toEqual([
      { path: '/v', recursive: true },
      { path: '/other', recursive: false },
    ]);
    expect(watchSpecs(null, '/other/b.md')).toEqual([{ path: '/other', recursive: false }]);
    await updateWatch();
    await updateWatch(); // 没变化不重复设置
    expect(fake.state.watched).toHaveLength(1);
  });

  it('外部新增文件：刷新文件树', async () => {
    fake.write('/v/new.md', 'N');
    handleFsChanges([{ path: '/v/new.md', kind: 'create', dir: false }]);
    await new Promise((r) => setTimeout(r, 120));
    expect(useApp.getState().tree?.some((e) => e.path === 'new.md')).toBe(true);
  });

  it('当前文件被外部修改、没有未保存修改：重新载入并保留视图', async () => {
    await openPath('/v/a.md');
    const docId = useApp.getState().docId;
    fake.write('/v/a.md', 'Agent 写的');
    handleFsChanges([{ path: '/v/a.md', kind: 'modify', dir: false }]);
    await flush();
    await flush();
    const s = useApp.getState();
    expect(s).toMatchObject({ text: 'Agent 写的', savedText: 'Agent 写的', dirty: false, keepView: true });
    expect(s.docId).toBe(docId + 1);
  });

  it('当前文件被外部修改、有未保存修改且改了同一处：进入并排合并，选择后保存不再冲突', async () => {
    await openPath('/v/a.md');
    type('我的修改');
    fake.write('/v/a.md', 'Agent 写的');
    handleFsChanges([{ path: '/v/a.md', kind: 'modify', dir: false }]);
    await waitFor(() => !!useApp.getState().merge);
    const m = useApp.getState().merge;
    expect(m?.merge.conflicts).toBe(1);
    expect(useApp.getState().text).toBe('我的修改');
    const { resolveConflicts } = await import('./review');
    resolveConflicts(['mine']);
    expect(useApp.getState()).toMatchObject({ text: '我的修改', savedText: 'Agent 写的', dirty: true, merge: null });
    fake.state.conflictAnswer = 'cancel';
    expect(await save()).toBe(true);
    expect(fake.state.files.get('/v/a.md')?.text).toBe('我的修改');
    expect(fake.state.asked).not.toContain('conflict:a.md');
  });

  it('外部修改和未保存的修改不冲突：自动合并', async () => {
    fake.write('/v/b.md', '第一段\n\n第二段\n');
    await openPath('/v/b.md');
    type('第一段我改了\n\n第二段\n');
    fake.write('/v/b.md', '第一段\n\n第二段\n\nAgent 加的\n');
    handleFsChanges([{ path: '/v/b.md', kind: 'modify', dir: false }]);
    await waitFor(() => useApp.getState().savedText.includes('Agent'));
    expect(useApp.getState().merge).toBeNull();
    expect(useApp.getState().text).toBe('第一段我改了\n\n第二段\n\nAgent 加的\n');
    expect(useApp.getState().dirty).toBe(true);
  });

  it('自己保存产生的事件不处理', async () => {
    await openPath('/v/a.md');
    type('新内容');
    await save();
    const docId = useApp.getState().docId;
    handleFsChanges([{ path: '/v/a.md', kind: 'modify', dir: false }]);
    await flush();
    await flush();
    expect(useApp.getState().docId).toBe(docId);
    expect(useApp.getState().notice?.error).toBeFalsy();
  });

  it('当前文件被外部删除：保留内容并提示', async () => {
    await openPath('/v/a.md');
    activeEditor.current = null;
    fake.state.files.delete('/v/a.md');
    handleFsChanges([{ path: '/v/a.md', kind: 'remove', dir: false }]);
    await flush();
    expect(useApp.getState()).toMatchObject({ text: 'A', filePath: '/v/a.md' });
    expect(useApp.getState().notice?.error).toBe(true);
  });
});
