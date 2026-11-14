/**
 * 内置 AI 的模型设置：已添加的服务、改写用哪一个、校验和旧设置迁移。
 * 单独成文件，只依赖 i18n 和服务商目录（它们不引用别的模块），store 可以放心引用。
 */
import { type Locale, locale } from '../i18n';
import { legacyProviderId, localName, PROVIDER_KINDS, type ProviderEntry, type ProviderKind, providerById } from './aiProviders';

export * from './aiProviders';

/** 一个已添加的服务（不含 key：key 按 id 存在系统钥匙串里） */
export interface ProviderConfig {
  id: string;
  /** 自定义服务的名字；目录里的服务商按 provider 显示当前界面语言的名字 */
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  /** 目录里的服务商 id（见 aiProviders.ts）；自定义服务是 custom */
  provider?: string;
  /** 上次同步到的模型列表 */
  models?: string[];
}

export interface AiSettings {
  /** 已添加的服务 */
  services: ProviderConfig[];
  /** 改写用哪个服务 */
  chatId: string | null;
  /** 以前库问答用的向量模型；问答已去掉，只为兼容旧设置保留 */
  embed: ProviderConfig | null;
  /** 以前的"保存后整理建议"开关；已去掉，只为兼容旧设置保留 */
  suggest: boolean;
}

export const defaultAi: AiSettings = { services: [], chatId: null, embed: null, suggest: true };

const newId = () => `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 从目录里的服务商生成一个新服务（还没添加） */
export function draftService(entry: ProviderEntry, lang: Locale = locale): ProviderConfig {
  return { id: newId(), name: entry.id === 'custom' ? '' : localName(entry, lang), kind: entry.kind, baseUrl: entry.baseUrl, model: entry.model ?? '', provider: entry.id };
}

/** 服务显示的名字：目录里的服务商跟着界面语言，自定义服务用自己的名字 */
export function serviceName(p: Pick<ProviderConfig, 'name' | 'provider'>, lang: Locale = locale): string {
  const entry = p.provider && p.provider !== 'custom' ? providerById(p.provider) : undefined;
  return entry ? localName(entry, lang) : p.name;
}

/** 改写用的服务；没设置就是 null */
export function chatService(ai: AiSettings): ProviderConfig | null {
  return ai.services.find((s) => s.id === ai.chatId) ?? null;
}

/** 发给 Rust 的部分（不带模型列表这些界面用的字段） */
export function wireProvider(p: ProviderConfig): Pick<ProviderConfig, 'id' | 'name' | 'kind' | 'baseUrl' | 'model'> {
  return { id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, model: p.model };
}

function sanitizeService(raw: unknown): ProviderConfig | null {
  const x = raw as Partial<ProviderConfig> | null;
  if (!x || typeof x.id !== 'string' || !PROVIDER_KINDS.includes(x.kind as ProviderKind) || typeof x.baseUrl !== 'string' || typeof x.model !== 'string') return null;
  const out: ProviderConfig = { id: x.id, name: typeof x.name === 'string' ? x.name : '', kind: x.kind as ProviderKind, baseUrl: x.baseUrl, model: x.model };
  out.provider = typeof x.provider === 'string' ? x.provider : legacyProviderId(out.name);
  if (Array.isArray(x.models)) out.models = x.models.filter((m): m is string => typeof m === 'string');
  return out;
}

/**
 * 校验设置。旧版本只有一个 chat（选一个预设），迁移成一个已添加的服务：id 不变，钥匙串里的 key 照样能用。
 */
export function sanitizeAi(raw: unknown): AiSettings {
  const r = (raw ?? {}) as Partial<AiSettings> & { chat?: unknown };
  let services = Array.isArray(r.services) ? r.services.map(sanitizeService).filter((s): s is ProviderConfig => !!s) : [];
  let chatId = typeof r.chatId === 'string' ? r.chatId : null;
  if (!Array.isArray(r.services)) {
    const legacy = sanitizeService(r.chat);
    if (legacy) {
      services = [legacy];
      chatId = legacy.id;
    }
  }
  // 同一个 id 只留第一个
  services = services.filter((s, i) => services.findIndex((x) => x.id === s.id) === i);
  if (!services.some((s) => s.id === chatId)) chatId = services[0]?.id ?? null;
  return {
    services,
    chatId,
    embed: sanitizeService(r.embed),
    suggest: typeof r.suggest === 'boolean' ? r.suggest : true,
  };
}
