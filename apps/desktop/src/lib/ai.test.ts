import { beforeEach, describe, expect, it } from 'vitest';
import { complete, presetName, presetsFor, rewritePrompt, sanitizeAi, selectionContext, streamChat, testPrompt } from './ai';
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
  it('中文界面：带上下文，翻译方向按原文判断', () => {
    const m = rewritePrompt('polish', '这段话', '前文【这段话】后文', '', 'zh-CN');
    expect(m[0]!.role).toBe('system');
    expect(m[1]!.content).toContain('润色');
    expect(m[1]!.content).toContain('前文【这段话】后文');
    expect(rewritePrompt('translate', '中文', '', '', 'zh-CN')[1]!.content).toContain('英文');
    expect(rewritePrompt('translate', 'English', '', '', 'zh-CN')[1]!.content).toContain('简体中文');
    expect(rewritePrompt('custom', 'x', '', '改成列表', 'zh-CN')[1]!.content).toContain('改成列表');
    expect(rewritePrompt('tone', 'x', '', '', 'zh-CN')[1]!.content).toContain('更正式');
    expect(selectionContext('前文', '这段话', '后文', 'zh-CN')).toBe('前文【这段话】后文');
    expect(testPrompt('zh-CN')[0]!.content).toBe('只回复 OK');
  });

  it('英文界面：改写要求用原文的语言回答', () => {
    const m = rewritePrompt('polish', '这段话', 'before «这段话» after', '', 'en');
    expect(m[0]!.role).toBe('system');
    expect(m[1]!.content).toContain('Polish');
    expect(m[1]!.content).toContain('same language as the given text');
    expect(m[1]!.content).toContain('before «这段话» after');
    expect(rewritePrompt('translate', '中文', '', '', 'en')[1]!.content).toContain('into English');
    expect(rewritePrompt('translate', 'English', '', '', 'en')[1]!.content).toContain('into Simplified Chinese');
    expect(rewritePrompt('tone', 'x', '', '', 'en')[1]!.content).toContain('more formal');
    expect(rewritePrompt('custom', 'x', '', 'make it a list', 'en')[1]!.content).toContain('make it a list');
    expect(selectionContext('a ', 'b', ' c', 'en')).toBe('a «b» c');
    expect(testPrompt('en')[0]!.content).toBe('Reply with just OK');
  });
});

describe('预设', () => {
  it('名字跟随界面语言，旧语言存的名字也认得', () => {
    expect(presetsFor('en').map((p) => p.name)).toContain('SiliconFlow');
    expect(presetsFor('zh-CN').map((p) => p.name)).toContain('硅基流动');
    expect(presetName('硅基流动', 'en')).toBe('SiliconFlow');
    expect(presetName('Zhipu AI', 'zh-CN')).toBe('智谱');
    expect(presetName('DeepSeek', 'zh-CN')).toBe('DeepSeek');
    expect(presetName('My server', 'en')).toBe('My server');
    expect(sanitizeAi({ chat: { ...P, name: '豆包' } }).chat?.name).toBe('豆包');
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
