/**
 * 内置 AI 的模型设置：类型、预设和校验。单独成文件，只依赖 i18n（它不引用别的模块），store 可以放心引用。
 */
import { type Locale, locale } from '../i18n';

export type ProviderKind = 'openai' | 'ollama';

/** 一个服务商配置（不含 key） */
export interface ProviderConfig {
  id: string;
  /** 显示的名字，例如 DeepSeek（选预设时按当时的界面语言存下来） */
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
}

type Preset = Omit<ProviderConfig, 'id'>;

/** 常见服务商的预设；name 是英文名，zh 是中文界面里显示的名字（没有就和英文一样） */
const PRESET_LIST: (Preset & { zh?: string })[] = [
  { name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'SiliconFlow', zh: '硅基流动', kind: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-8B' },
  { name: 'Doubao', zh: '豆包', kind: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1-6-250615' },
  { name: 'Zhipu AI', zh: '智谱', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  { name: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b' },
];

/** 某种界面语言下的预设（名字跟着语言） */
export function presetsFor(lang: Locale): Preset[] {
  return PRESET_LIST.map(({ zh, ...p }) => ({ ...p, name: lang === 'zh-CN' && zh ? zh : p.name }));
}

/** 当前界面语言下的预设 */
export const PRESETS: Preset[] = presetsFor(locale);

/**
 * 存下来的服务商名字 → 当前界面语言下显示的名字。
 * 换了界面语言后，以前按另一种语言存的预设名也能认出来；不是预设名就原样返回。
 */
export function presetName(name: string, lang: Locale = locale): string {
  const p = PRESET_LIST.find((x) => x.name === name || x.zh === name);
  return p ? (lang === 'zh-CN' && p.zh ? p.zh : p.name) : name;
}

export interface AiSettings {
  /** 选中改写用的对话模型 */
  chat: ProviderConfig | null;
  /** 以前库问答用的向量模型；问答已去掉，只为兼容旧设置保留 */
  embed: ProviderConfig | null;
  /** 以前的"保存后整理建议"开关；已去掉，只为兼容旧设置保留 */
  suggest: boolean;
}

export const defaultAi: AiSettings = { chat: null, embed: null, suggest: true };

export function sanitizeAi(raw: unknown): AiSettings {
  const r = (raw ?? {}) as Partial<AiSettings>;
  const ok = (p: unknown): p is ProviderConfig => {
    const x = p as ProviderConfig | null;
    return !!x && typeof x.id === 'string' && (x.kind === 'openai' || x.kind === 'ollama') && typeof x.baseUrl === 'string' && typeof x.model === 'string';
  };
  return {
    chat: ok(r.chat) ? r.chat : null,
    embed: ok(r.embed) ? r.embed : null,
    suggest: typeof r.suggest === 'boolean' ? r.suggest : true,
  };
}
