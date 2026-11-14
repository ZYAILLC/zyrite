/**
 * 服务商目录：设置 › AI 模型左边那一列。每个服务商对应一种协议（Rust 侧 zyrite-ai 的 Kind），
 * 加一个服务商只要在这里加一条，不用改代码。
 *
 * 地址、密钥页面和推荐模型以各家文档为准；标了 preview 的（编程套餐、订阅登录）先只展示，还不能添加：
 * 接通前要逐家确认它的使用条款允许在写作工具里用，再去掉 preview。
 *
 * 只依赖 i18n 的类型，store 可以放心引用。
 */
import type { Locale } from '../i18n';

/** 协议：openai = OpenAI 兼容接口，anthropic = Anthropic Messages，ollama = Ollama 原生接口，codex = ChatGPT 订阅（未实现） */
export type ProviderKind = 'openai' | 'anthropic' | 'ollama' | 'codex';

export const PROVIDER_KINDS: readonly ProviderKind[] = ['openai', 'anthropic', 'ollama', 'codex'];

/** 自定义服务可以选的协议 */
export const CUSTOM_KINDS: readonly ProviderKind[] = ['openai', 'anthropic', 'ollama'];

/** 分组：按量 API、编程套餐、订阅、本地与自定义 */
export type ProviderGroup = 'payg' | 'plan' | 'subscription' | 'local';

export const PROVIDER_GROUPS: readonly ProviderGroup[] = ['payg', 'plan', 'subscription', 'local'];

/**
 * 认证方式：
 * - apiKey：必须填 API 密钥
 * - optionalKey：可填可不填（自定义服务）
 * - none：不需要（本地模型）
 * - oauth：在浏览器里登录授权（订阅），还没实现
 */
export type AuthMethod = 'apiKey' | 'optionalKey' | 'none' | 'oauth';

export interface ProviderRegion {
  name: string;
  zh?: string;
  baseUrl: string;
}

export interface ProviderEntry {
  id: string;
  /** 英文名；zh 是中文界面里的名字（没有就和英文一样） */
  name: string;
  zh?: string;
  group: ProviderGroup;
  /** 图标：一两个字母，不用各家的商标 */
  mark: string;
  kind: ProviderKind;
  /** 默认地址；有 regions 时是第一个区域的地址 */
  baseUrl: string;
  /** 国内版、国际版等不同地址 */
  regions?: ProviderRegion[];
  auth: AuthMethod;
  /** 支持"免费连接"：在浏览器登录后自动添加（还没实现，按钮会提示即将支持） */
  connect?: boolean;
  /** 获取 API 密钥的页面 */
  keyUrl?: string;
  /** 推荐的模型（添加时预填，可以改） */
  model?: string;
  /** 先只展示，还不能添加 */
  preview?: boolean;
}

export const PROVIDERS: readonly ProviderEntry[] = [
  // ---------- 按量 API ----------
  { id: 'orcarouter', name: 'OrcaRouter', group: 'payg', mark: 'OR', kind: 'openai', baseUrl: 'https://api.orcarouter.ai/v1', auth: 'apiKey', connect: true },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    group: 'payg',
    mark: 'DS',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    auth: 'apiKey',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    model: 'deepseek-chat',
  },
  {
    id: 'bailian',
    name: 'Qwen · Model Studio',
    zh: '通义千问 · 百炼',
    group: 'payg',
    mark: 'QW',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    regions: [
      { name: 'China', zh: '国内', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { name: 'International', zh: '国际', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    ],
    auth: 'apiKey',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    model: 'qwen-plus',
  },
  {
    id: 'zhipu',
    name: 'Zhipu GLM',
    zh: '智谱 GLM',
    group: 'payg',
    mark: 'Z',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    regions: [
      { name: 'China', zh: '国内', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
      { name: 'International (Z.ai)', zh: '国际（Z.ai）', baseUrl: 'https://api.z.ai/api/paas/v4' },
    ],
    auth: 'apiKey',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    model: 'glm-4-flash',
  },
  {
    id: 'moonshot',
    name: 'Kimi · Moonshot',
    group: 'payg',
    mark: 'K',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    regions: [
      { name: 'China', zh: '国内', baseUrl: 'https://api.moonshot.cn/v1' },
      { name: 'International', zh: '国际', baseUrl: 'https://api.moonshot.ai/v1' },
    ],
    auth: 'apiKey',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'doubao',
    name: 'Doubao · Volcano Ark',
    zh: '豆包 · 火山方舟',
    group: 'payg',
    mark: 'DB',
    kind: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    auth: 'apiKey',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    model: 'doubao-seed-1-6-250615',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    group: 'payg',
    mark: 'MM',
    kind: 'openai',
    baseUrl: 'https://api.minimaxi.com/v1',
    regions: [
      { name: 'China', zh: '国内', baseUrl: 'https://api.minimaxi.com/v1' },
      { name: 'International', zh: '国际', baseUrl: 'https://api.minimax.io/v1' },
    ],
    auth: 'apiKey',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    zh: '硅基流动',
    group: 'payg',
    mark: 'SF',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    auth: 'apiKey',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    model: 'Qwen/Qwen3-8B',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    group: 'payg',
    mark: 'AI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    auth: 'apiKey',
    keyUrl: 'https://platform.openai.com/api-keys',
    model: 'gpt-4.1-mini',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    group: 'payg',
    mark: 'A',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    auth: 'apiKey',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    model: 'claude-sonnet-5-5',
  },
  { id: 'openrouter', name: 'OpenRouter', group: 'payg', mark: 'OP', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', auth: 'apiKey', keyUrl: 'https://openrouter.ai/keys' },

  // ---------- 编程套餐（先只展示） ----------
  { id: 'kimi-code', name: 'Kimi Code', group: 'plan', mark: 'K', kind: 'anthropic', baseUrl: 'https://api.kimi.com/coding/v1', auth: 'apiKey', preview: true },
  {
    id: 'glm-coding',
    name: 'Zhipu GLM Coding Plan',
    zh: '智谱 GLM Coding Plan',
    group: 'plan',
    mark: 'Z',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    auth: 'apiKey',
    preview: true,
  },
  {
    id: 'bailian-plan',
    name: 'Model Studio Token Plan',
    zh: '百炼 Token Plan',
    group: 'plan',
    mark: 'QW',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    auth: 'apiKey',
    preview: true,
  },
  { id: 'minimax-plan', name: 'MiniMax Token Plan', group: 'plan', mark: 'MM', kind: 'openai', baseUrl: 'https://api.minimaxi.com/v1', auth: 'apiKey', preview: true },
  {
    id: 'ark-coding',
    name: 'Volcano Ark Coding Plan',
    zh: '火山方舟 Coding Plan',
    group: 'plan',
    mark: 'VA',
    kind: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    auth: 'apiKey',
    preview: true,
  },

  // ---------- 订阅（先只展示） ----------
  { id: 'chatgpt', name: 'ChatGPT (Codex)', group: 'subscription', mark: 'AI', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', auth: 'oauth', preview: true },

  // ---------- 本地与自定义 ----------
  { id: 'ollama', name: 'Ollama', group: 'local', mark: 'OL', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', auth: 'none', model: 'qwen3:8b' },
  { id: 'lmstudio', name: 'LM Studio', group: 'local', mark: 'LS', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', auth: 'none' },
  { id: 'custom', name: 'Custom service', zh: '自定义服务', group: 'local', mark: '+', kind: 'openai', baseUrl: '', auth: 'optionalKey' },
];

export function providerById(id: string | undefined): ProviderEntry | undefined {
  return id ? PROVIDERS.find((p) => p.id === id) : undefined;
}

/** 按界面语言取名字 */
export function localName(x: { name: string; zh?: string }, lang: Locale): string {
  return lang === 'zh-CN' && x.zh ? x.zh : x.name;
}

/** 旧版本存的服务商名字（英文或中文，例如"智谱"、"Zhipu AI"）→ 目录里的服务商 */
const LEGACY_NAMES: Record<string, string> = {
  DeepSeek: 'deepseek',
  SiliconFlow: 'siliconflow',
  硅基流动: 'siliconflow',
  Doubao: 'doubao',
  豆包: 'doubao',
  'Zhipu AI': 'zhipu',
  智谱: 'zhipu',
  OpenAI: 'openai',
  Ollama: 'ollama',
};

/** 认出旧设置里的服务商；认不出就当自定义服务 */
export function legacyProviderId(name: string): string {
  return LEGACY_NAMES[name] ?? PROVIDERS.find((p) => p.name === name || p.zh === name)?.id ?? 'custom';
}
