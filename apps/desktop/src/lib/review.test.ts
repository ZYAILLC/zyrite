import { beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../store';
import { deps, openPath } from './document';
import { fakeBackend, resetStore } from './fakeBackend.testutil';
import { t } from '../i18n';
import { acceptAll, acceptChange, guessAgent, refreshReview, rejectAll, rejectChange } from './review';

let fake: ReturnType<typeof fakeBackend>;
const P = '/v/docs/a.md';
const BASE = '# 架构\n\n第一段。\n\n第二段。\n';
const AGENT = '# 架构\n\n第一段改了。\n\n第二段。\n\n新增一段。\n';

beforeEach(async () => {
  resetStore();
  fake = fakeBackend();
  deps.backend = fake.b;
  useApp.getState().setFolder('/v');
});

async function openWith(disk: string, baseline: string | null) {
  fake.write(P, disk);
  if (baseline !== null) fake.state.baselines.set(P, baseline);
  await openPath(P);
  await refreshReview();
}

describe('第一次打开', () => {
  it('没有基线：当前内容成为基线，没有待审阅', async () => {
    await openWith(BASE, null);
    expect(fake.state.baselines.get(P)).toBe(BASE);
    expect(useApp.getState().review).toBeNull();
  });
});

describe('Agent 直接写了磁盘', () => {
  it('和基线比较出两处改动；逐处接受，基线跟着前进', async () => {
    await openWith(AGENT, BASE);
    const r = useApp.getState().review!;
    expect(r.source).toBe('disk');
    expect(r.hunks).toHaveLength(2);
    expect(r.agent).toBeTruthy();
    await acceptChange(0);
    expect(useApp.getState().review?.hunks).toHaveLength(1);
    expect(fake.state.files.get(P)?.text).toBe(AGENT); // 磁盘不动
    await acceptChange(0);
    expect(useApp.getState().review).toBeNull();
    expect(fake.state.baselines.get(P)).toBe(AGENT);
  });

  it('拒绝一处：把这一块写回磁盘，另一处仍待审阅', async () => {
    await openWith(AGENT, BASE);
    await rejectChange(1); // 新增一段
    expect(fake.state.files.get(P)?.text).toBe('# 架构\n\n第一段改了。\n\n第二段。\n');
    expect(useApp.getState().text).toBe('# 架构\n\n第一段改了。\n\n第二段。\n');
    const r = useApp.getState().review!;
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]?.added).toEqual(['第一段改了。']);
  });

  it('全部拒绝：磁盘恢复成基线', async () => {
    await openWith(AGENT, BASE);
    await rejectAll();
    expect(fake.state.files.get(P)?.text).toBe(BASE);
    expect(useApp.getState().review).toBeNull();
  });

  it('设置里关了审阅：直接接受', async () => {
    fake.state.config = { ...fake.state.config, review: { enabled: false } };
    await openWith(AGENT, BASE);
    expect(useApp.getState().review).toBeNull();
    expect(fake.state.baselines.get(P)).toBe(AGENT);
  });
});

describe('Agent 通过 MCP 写入（审阅队列）', () => {
  beforeEach(async () => {
    fake.state.queue.set(P, { id: 'q1', path: 'docs/a.md', content: AGENT, agent: 'Claude Code', reason: '补充', createdMs: 1 });
    await openWith(BASE, BASE);
  });

  it('显示写入者和理由；接受一处才写进磁盘', async () => {
    const r = useApp.getState().review!;
    expect(r).toMatchObject({ source: 'queue', agent: 'Claude Code', reason: '补充' });
    expect(fake.state.files.get(P)?.text).toBe(BASE);
    await acceptChange(0);
    expect(fake.state.files.get(P)?.text).toBe('# 架构\n\n第一段改了。\n\n第二段。\n');
    expect(fake.state.baselines.get(P)).toBe('# 架构\n\n第一段改了。\n\n第二段。\n');
    expect(useApp.getState().review?.hunks).toHaveLength(1);
    await acceptChange(0);
    expect(fake.state.files.get(P)?.text).toBe(AGENT);
    expect(fake.state.queue.has(P)).toBe(false);
    expect(useApp.getState().review).toBeNull();
  });

  it('拒绝一处：从提议里撤掉，磁盘不动；全部拒绝清空队列', async () => {
    await rejectChange(0);
    expect(fake.state.files.get(P)?.text).toBe(BASE);
    expect(fake.state.queue.get(P)?.content).toBe('# 架构\n\n第一段。\n\n第二段。\n\n新增一段。\n');
    await rejectAll();
    expect(fake.state.queue.has(P)).toBe(false);
    expect(useApp.getState().review).toBeNull();
  });

  it('全部接受', async () => {
    await acceptAll();
    expect(fake.state.files.get(P)?.text).toBe(AGENT);
    expect(fake.state.queue.has(P)).toBe(false);
  });
});

describe('直接写磁盘的改动是谁写的', () => {
  const agent = (name: string, pid: number) => ({ pid, name, startedMs: 0, lastSeenMs: 0 });

  it('没有连着的 Agent：外部程序', async () => {
    expect(await guessAgent()).toBe(t.externalProgram);
  });

  it('只连着一个：算它的，哪怕很久没调 MCP', async () => {
    fake.state.agents = [agent('Claude Code', 1)];
    expect(await guessAgent()).toBe(t.inferredAgent('Claude Code'));
  });

  it('连着好几个：取最近 2 分钟有活动的', async () => {
    fake.state.agents = [agent('Claude Code', 1), agent('Cursor', 2)];
    expect(await guessAgent()).toBe(t.externalProgram);
    fake.state.activity = [
      { atMs: Date.now() - 60_000, agent: 'Claude Code', action: 'read', added: 0, removed: 0 },
      { atMs: Date.now() - 5_000, agent: 'Cursor', action: 'read', added: 0, removed: 0 },
    ];
    expect(await guessAgent()).toBe(t.inferredAgent('Cursor'));
  });
});
