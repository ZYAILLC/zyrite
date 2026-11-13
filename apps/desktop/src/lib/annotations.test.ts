import { beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../store';
import { deps, openPath } from './document';
import { fakeBackend, resetStore } from './fakeBackend.testutil';
import { createAnnotation, deleteAnnotation, followUp, loadAnnotations, marksFor, setStatus, shownStatus } from './annotations';

let fake: ReturnType<typeof fakeBackend>;
const P = '/v/docs/a.md';

beforeEach(async () => {
  resetStore();
  fake = fakeBackend();
  deps.backend = fake.b;
  useApp.getState().setFolder('/v');
  fake.write(P, '对外提供五个工具，写入进队列。');
  await openPath(P);
});

describe('批注', () => {
  it('新建、追问、改状态、删除，都存进 .zyrite/annotations', async () => {
    await createAnnotation({ text: '五个工具', prefix: '对外提供', suffix: '，写入' }, '再加一个 reply_annotation', 'any');
    let a = fake.state.annotations.get(P)![0]!;
    expect(a).toMatchObject({ file: 'docs/a.md', status: 'open', assignee: 'any', body: '再加一个 reply_annotation' });
    expect(marksFor(useApp.getState().annotations)).toEqual([
      { id: a.id, n: 1, anchor: a.anchor, resolved: false },
    ]);

    await setStatus(a.id, 'changed');
    await followUp(a.id, '还要写进文档');
    a = fake.state.annotations.get(P)![0]!;
    expect(a.status).toBe('open');
    expect(a.thread).toEqual([expect.objectContaining({ by: 'user', text: '还要写进文档' })]);

    await deleteAnnotation(a.id);
    expect(fake.state.annotations.get(P)).toEqual([]);
  });

  it('待处理的批注找不到锚点：位置已失效；Agent 已修改、已解决的保持原状态', async () => {
    await createAnnotation({ text: '六个工具', prefix: '', suffix: '' }, 'x', 'any');
    const a = useApp.getState().annotations[0]!;
    expect(shownStatus(a, useApp.getState().text)).toBe('orphaned');
    expect(shownStatus({ ...a, status: 'changed' }, useApp.getState().text)).toBe('changed');
    expect(shownStatus({ ...a, status: 'resolved' }, useApp.getState().text)).toBe('resolved');
  });

  it('Agent 通过 MCP 回复后重新读取', async () => {
    await createAnnotation({ text: '五个工具', prefix: '', suffix: '' }, 'x', 'any');
    const id = useApp.getState().annotations[0]!.id;
    fake.state.annotations.set(P, [
      { ...fake.state.annotations.get(P)![0]!, status: 'changed', thread: [{ by: 'Claude Code', at: '1', text: '已改' }] },
    ]);
    await loadAnnotations();
    expect(useApp.getState().annotations[0]).toMatchObject({ id, status: 'changed' });
  });
});
