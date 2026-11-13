import { beforeEach, describe, expect, it } from 'vitest';
import { complete, rewritePrompt, sanitizeAi, streamChat } from './ai';
import { deps } from './document';
import { fakeBackend, resetStore } from './fakeBackend.testutil';

let fake: ReturnType<typeof fakeBackend>;
const P = { id: 'p1', name: 'DeepSeek', kind: 'openai' as const, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };

beforeEach(() => {
  resetStore();
  fake = fakeBackend();
  deps.backend = fake.b;
});

describe('提示词', () => {
  it('改写：带上下文，翻译方向按原文判断', () => {
    const m = rewritePrompt('polish', '这段话', '前文【这段话】后文');
    expect(m[0]!.role).toBe('system');
    expect(m[1]!.content).toContain('润色');
    expect(m[1]!.content).toContain('前文【这段话】后文');
    expect(rewritePrompt('translate', '中文', '')[1]!.content).toContain('英文');
    expect(rewritePrompt('translate', 'English', '')[1]!.content).toContain('简体中文');
    expect(rewritePrompt('custom', 'x', '', '改成列表')[1]!.content).toContain('改成列表');
  });
});

describe('调用', () => {
  it('流式输出拼成完整回答', async () => {
    fake.state.aiAnswer = '你好，世界';
    const deltas: string[] = [];
    const full = await new Promise<string>((resolve) =>
      streamChat(P, [{ role: 'user', content: 'hi' }], { onDelta: (d) => deltas.push(d), onDone: resolve }),
    );
    expect(full).toBe('你好，世界');
    expect(deltas.join('')).toBe('你好，世界');
    expect(await complete(P, [{ role: 'user', content: 'hi' }])).toBe('你好，世界');
  });

  it('设置校验', () => {
    expect(sanitizeAi({ chat: { id: 1 }, suggest: 'x' })).toEqual({ chat: null, embed: null, suggest: true });
    expect(sanitizeAi({ chat: P, suggest: false }).chat).toEqual(P);
  });
});
