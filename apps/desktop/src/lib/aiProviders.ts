/**
 * 服务商目录：设置 › AI 模型左边那一列。每个服务商对应一种协议（Rust 侧 zyrite-ai 的 Kind），
 * 加一个服务商只要在这里加一条，不用改代码。
 *
 * 地址、密钥页面和推荐模型以各家文档为准，只是预填的默认值，用户可以自己改。
 * 只放已经能用的服务；没做完的（比如要浏览器登录的订阅）做完再加，不在界面上放"即将支持"。
 *
 * 只依赖 i18n 的类型，store 可以放心引用。
 */
import type { Locale } from '../i18n';

/** 协议：openai = OpenAI 兼容接口，anthropic = Anthropic Messages，ollama = Ollama 原生接口，chatgpt = ChatGPT 套餐（Responses API，浏览器登录） */
export type ProviderKind = 'openai' | 'anthropic' | 'ollama' | 'chatgpt';

export const PROVIDER_KINDS: readonly ProviderKind[] = ['openai', 'anthropic', 'ollama', 'chatgpt'];

/** 自定义服务可以选的协议 */
export const CUSTOM_KINDS: readonly ProviderKind[] = ['openai', 'anthropic', 'ollama'];

/** 分组：按量 API、订阅（编程套餐、Token Plan 等包月服务都算订阅）、本地与自定义 */
export type ProviderGroup = 'payg' | 'subscription' | 'local';

export const PROVIDER_GROUPS: readonly ProviderGroup[] = ['payg', 'subscription', 'local'];

/**
 * 认证方式：
 * - apiKey：必须填 API 密钥
 * - optionalKey：可填可不填（自定义服务）
 * - none：不需要（本地模型）
 * - oauth：在浏览器里登录授权，没有密钥可填（ChatGPT 套餐）
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
  /** 支持"免费连接"：在浏览器登录授权后自动拿到 API 密钥（OAuth + PKCE，Rust 侧 zyrite-ai::oauth） */
  connect?: boolean;
  /** 获取 API 密钥的页面 */
  keyUrl?: string;
  /** 推荐的模型（添加时预填，可以改） */
  model?: string;
}

export const PROVIDERS: readonly ProviderEntry[] = [
  // ---------- 按量 API ----------
  {
    id: 'orcarouter',
    name: 'OrcaRouter',
    group: 'payg',
    mark: 'OR',
    kind: 'openai',
    baseUrl: 'https://api.orcarouter.ai/v1',
    auth: 'apiKey',
    connect: true,
    keyUrl: 'https://www.orcarouter.ai/console',
    model: 'orcarouter/free',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    group: 'payg',
    mark: 'DS',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com',
    auth: 'apiKey',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    model: 'deepseek-flash',
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
    model: 'qwen3.7-plus',
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
    model: 'glm-4.7-flash',
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
    keyUrl: 'https://platform.kimi.com/console/api-keys',
    model: 'kimi-k3.1-pro',
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
    keyUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey',
    model: 'doubao-seed-2-1-pro-260915',
  },
  {
    id: 'hunyuan',
    name: 'Tencent Hunyuan',
    zh: '腾讯混元',
    group: 'payg',
    mark: 'HY',
    kind: 'openai',
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    regions: [
      { name: 'China', zh: '国内', baseUrl: 'https://tokenhub.tencentmaas.com/v1' },
      { name: 'International', zh: '国际', baseUrl: 'https://tokenhub-intl.tencentmaas.com/v1' },
    ],
    auth: 'apiKey',
    keyUrl: 'https://console.cloud.tencent.com/tokenhub/apikey',
    model: 'hy4',
  },
  {
    id: 'qianfan',
    name: 'ERNIE · Baidu Qianfan',
    zh: '文心 · 百度千帆',
    group: 'payg',
    mark: 'EB',
    kind: 'openai',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    auth: 'apiKey',
    keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
    model: 'ernie-5.1',
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
    name: 'Claude · Anthropic',
    group: 'payg',
    mark: 'A',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    auth: 'apiKey',
    keyUrl: 'https://platform.claude.com/settings/keys',
    model: 'claude-sonnet-5-5',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    group: 'payg',
    mark: 'G',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    auth: 'apiKey',
    keyUrl: 'https://aistudio.google.com/apikey',
    model: 'gemini-3.5-flash-lite',
  },
  {
    id: 'xai',
    name: 'Grok · xAI',
    group: 'payg',
    mark: 'X',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    auth: 'apiKey',
    keyUrl: 'https://console.x.ai/team/default/api-keys',
    model: 'grok-4.3',
  },
  { id: 'openrouter', name: 'OpenRouter', group: 'payg', mark: 'OP', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', auth: 'apiKey', connect: true, keyUrl: 'https://openrouter.ai/keys' },

  // ---------- 订阅（编程套餐、Token Plan 等包月服务）----------
  // 只给入口和已知的默认地址，密钥、地址、模型由用户自己填。很多套餐的条款只允许在指定工具里用，表单里会提示用户自己确认。
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    group: 'subscription',
    mark: 'K',
    kind: 'anthropic',
    baseUrl: 'https://api.kimi.com/coding/v1',
    regions: [
      { name: 'China', zh: '国内', baseUrl: 'https://api.kimi.com/coding/v1' },
      { name: 'International', zh: '国际', baseUrl: 'https://api.kimi.ai/coding/v1' },
    ],
    auth: 'apiKey',
    keyUrl: 'https://www.kimi.com/code/console',
    model: 'k3.1-pro',
  },
  {
    id: 'glm-coding',
    name: 'Zhipu GLM Coding Plan',
    zh: '智谱 GLM Coding Plan',
    group: 'subscription',
    mark: 'Z',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    regions: [
      { name: 'China', zh: '国内', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
      { name: 'International (Z.ai)', zh: '国际（Z.ai）', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
    ],
    auth: 'apiKey',
    keyUrl: 'https://bigmodel.cn/apikey/coding-plan-per',
    model: 'glm-5.2',
  },
  {
    id: 'bailian-plan',
    name: 'Model Studio Token Plan',
    zh: '百炼 Token Plan',
    group: 'subscription',
    mark: 'QW',
    kind: 'openai',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    auth: 'apiKey',
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan/personal',
    model: 'auto',
  },
  {
    id: 'bailian-coding',
    name: 'Model Studio Coding Plan',
    zh: '百炼 Coding Plan',
    group: 'subscription',
    mark: 'QW',
    kind: 'openai',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    auth: 'apiKey',
  },
  { id: 'minimax-plan', name: 'MiniMax Token Plan', group: 'subscription', mark: 'MM', kind: 'openai', baseUrl: 'https://api.minimaxi.com/v1', auth: 'apiKey', model: 'MiniMax-M3' },
  {
    id: 'ark-coding',
    name: 'Volcano Ark Coding Plan',
    zh: '火山方舟 Coding Plan',
    group: 'subscription',
    mark: 'VA',
    kind: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    auth: 'apiKey',
    keyUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey',
    model: 'ark-code-latest',
  },
  {
    id: 'tencent-coding',
    name: 'Tencent Cloud Coding Plan',
    zh: '腾讯云 Coding Plan',
    group: 'subscription',
    mark: 'TC',
    kind: 'openai',
    baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3',
    auth: 'apiKey',
    keyUrl: 'https://console.cloud.tencent.com/tokenhub/codingplan',
    model: 'tc-code-latest',
  },
  {
    id: 'qianfan-plan',
    name: 'Baidu Qianfan Token Plan',
    zh: '百度千帆 Token Plan',
    group: 'subscription',
    mark: 'EB',
    kind: 'openai',
    baseUrl: 'https://qianfan.baidubce.com/v2/tokenplan/personal',
    auth: 'apiKey',
    keyUrl: 'https://console.bce.baidu.com/qianfan/resource/token-plan',
    model: 'qianfan-code-latest',
  },

  // ChatGPT 套餐：OpenAI 官方的 Sign in with ChatGPT（开源、本地运行的应用可用），用量算在用户的 ChatGPT 套餐里
  { id: 'chatgpt', name: 'ChatGPT', group: 'subscription', mark: 'AI', kind: 'chatgpt', baseUrl: 'https://api.openai.com/v1', auth: 'oauth' },

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
  Hunyuan: 'hunyuan',
  Anthropic: 'anthropic',
  文心: 'qianfan',
  千帆: 'qianfan',
  混元: 'hunyuan',
  腾讯混元: 'hunyuan',
  OpenAI: 'openai',
  Ollama: 'ollama',
};

/** 认出旧设置里的服务商；认不出就当自定义服务 */
export function legacyProviderId(name: string): string {
  return LEGACY_NAMES[name] ?? PROVIDERS.find((p) => p.name === name || p.zh === name)?.id ?? 'custom';
}
