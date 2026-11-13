import { beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../store';
import { answerRequest, loadAccess, revokeGrant, setGrant } from './access';
import { deps } from './document';
import { fakeBackend, resetStore } from './fakeBackend.testutil';

let fake: ReturnType<typeof fakeBackend>;

beforeEach(() => {
  resetStore();
  fake = fakeBackend();
  deps.backend = fake.b;
  useApp.getState().setFolder('/v');
  fake.state.access.requests.push(
    { id: 'r1', name: 'Claude Code', exe: '/opt/claude', pid: 1, createdMs: Date.now() },
    { id: 'r2', name: 'Cursor', exe: '/opt/cursor', pid: 2, createdMs: Date.now() },
  );
});

describe('MCP 接入授权', () => {
  it('允许：生成一条读 + 提交写入的授权；拒绝：请求消失、不生成授权', async () => {
    await loadAccess();
    expect(useApp.getState().access.requests.map((r) => r.id)).toEqual(['r1', 'r2']);
    await answerRequest('r1', true);
    await answerRequest('r2', false);
    const { access } = useApp.getState();
    expect(access.requests).toEqual([]);
    expect(access.grants).toEqual([expect.objectContaining({ name: 'Claude Code', write: true, directWrite: false })]);
  });

  it('改权限：关掉提交写入时直接写入也一起关；撤销后列表为空', async () => {
    await loadAccess();
    await answerRequest('r1', true);
    let g = useApp.getState().access.grants[0]!;
    await setGrant(g, true, true);
    g = useApp.getState().access.grants[0]!;
    expect(g).toMatchObject({ write: true, directWrite: true });
    await setGrant(g, false, true);
    expect(useApp.getState().access.grants[0]).toMatchObject({ write: false, directWrite: false });
    await revokeGrant(g.id);
    expect(useApp.getState().access.grants).toEqual([]);
  });

  it('没打开库：清空', async () => {
    await loadAccess();
    useApp.getState().setFolder(null);
    await loadAccess();
    expect(useApp.getState().access).toEqual({ grants: [], requests: [] });
  });
});
