import { beforeEach, describe, expect, it } from 'vitest';
import {
  chatService,
  complete,
  draftService,
  legacyProviderId,
  PROVIDER_GROUPS,
  PROVIDERS,
  providerById,
  rewritePrompt,
  sanitizeAi,
  selectionContext,
  serviceName,
  streamChat,
  testPrompt,
} from './ai';
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

describe('服务商目录', () => {
  it('id 不重复，每个分组都有服务商，每条都能用', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of PROVIDER_GROUPS) expect(PROVIDERS.some((p) => p.group === g)).toBe(true);
    for (const p of PROVIDERS) {
      expect(p.mark.length).toBeGreaterThan(0);
      if (p.id !== 'custom') expect(p.baseUrl).toMatch(/^https?:\/\//);
      if (p.regions) expect(p.regions.map((r) => r.baseUrl)).toContain(p.baseUrl);
      if (p.keyUrl) expect(p.keyUrl).toMatch(/^https:\/\//);
    }
  });

  it('订阅和编程套餐先只展示；本地模型不要密钥', () => {
    expect(PROVIDERS.filter((p) => p.group === 'subscription' || p.group === 'plan').every((p) => p.preview)).toBe(true);
    expect(PROVIDERS.filter((p) => p.group === 'payg').some((p) => p.preview)).toBe(false);
    expect(providerById('ollama')?.auth).toBe('none');
    expect(providerById('anthropic')?.kind).toBe('anthropic');
    expect(providerById('chatgpt')?.auth).toBe('oauth');
  });

  it('名字跟随界面语言，旧版本存的名字也认得', () => {
    const zhipu = draftService(providerById('zhipu')!, 'en');
    expect(zhipu).toMatchObject({ provider: 'zhipu', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' });
    expect(serviceName(zhipu, 'zh-CN')).toBe('智谱 GLM');
    expect(serviceName(zhipu, 'en')).toBe('Zhipu GLM');
    expect(serviceName({ name: '公司内网', provider: 'custom' }, 'en')).toBe('公司内网');
    expect(legacyProviderId('智谱')).toBe('zhipu');
    expect(legacyProviderId('Zhipu AI')).toBe('zhipu');
    expect(legacyProviderId('硅基流动')).toBe('siliconflow');
    expect(legacyProviderId('My server')).toBe('custom');
  });
});

describe('设置', () => {
  it('旧版本的单个 chat 迁移成一个服务，id 不变（钥匙串里的 key 照样能用）', () => {
    const ai = sanitizeAi({ chat: { ...P, name: '豆包' }, embed: null, suggest: false });
    expect(ai.services).toEqual([{ ...P, name: '豆包', provider: 'doubao' }]);
    expect(ai.chatId).toBe('p1');
    expect(chatService(ai)?.id).toBe('p1');
    expect(ai.suggest).toBe(false);
  });

  it('校验：丢掉坏的服务和重复 id，chatId 失效时改用第一个', () => {
    const ai = sanitizeAi({
      services: [{ ...P, provider: 'deepseek' }, { id: 2 }, { ...P, model: 'dup' }, { ...P, id: 'p2', kind: 'anthropic', provider: 'anthropic', models: ['a', 3] }],
      chatId: 'gone',
    });
    expect(ai.services.map((s) => s.id)).toEqual(['p1', 'p2']);
    expect(ai.services[1]!.models).toEqual(['a']);
    expect(ai.chatId).toBe('p1');
    expect(sanitizeAi({ services: [], chat: P }).services).toEqual([]);
    expect(sanitizeAi(null)).toEqual({ services: [], chatId: null, embed: null, suggest: true });
    expect(sanitizeAi({ services: [{ ...P, kind: 'gemini' }] }).services).toEqual([]);
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

  it('发给后端的服务不带模型列表这些界面字段', async () => {
    await complete({ ...P, provider: 'deepseek', models: ['x', 'y'] }, [{ role: 'user', content: 'hi' }]);
    expect(fake.state.aiProviders.at(-1)).toEqual(P);
  });
});
