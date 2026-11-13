import { type CommandId, defaultKeymap } from './keymap';

/**
 * M5 的设置项（图片、导出、快捷键、Typora 主题）：类型、默认值和校验。
 * 不依赖 store，store 和各功能模块都能引用，避免循环依赖（同 aiConfig.ts）。
 */

/** 图片 */
export interface ImagePrefs {
  /** 粘贴、拖入的图片存到哪里：按模板存到本地 / 不复制（拖入时直接引用原文件） */
  save: 'template' | 'none';
  /** 相对当前文档的路径模板，扩展名按图片实际格式替换 */
  template: string;
  /** 上传图床：不上传 / PicGo·PicList 本地 HTTP 接口 / 自定义命令 */
  upload: 'none' | 'picgo' | 'command';
  picgoUrl: string;
  /** 自定义命令：图片路径作为最后一个参数，输出里的最后一个 URL 就是图片地址 */
  command: string;
}

export const DEFAULT_IMAGE_TEMPLATE = './assets/{filename}-{yyyyMMdd-HHmmss}.png';
export const DEFAULT_PICGO_URL = 'http://127.0.0.1:36677/upload';

export const defaultImagePrefs: ImagePrefs = {
  save: 'template',
  template: DEFAULT_IMAGE_TEMPLATE,
  upload: 'none',
  picgoUrl: DEFAULT_PICGO_URL,
  command: '',
};

/** 导出 */
export interface ExportPrefs {
  paper: 'A4' | 'Letter';
  /** 页边距（毫米） */
  margin: number;
  /** 页眉：无 / 文档标题；页脚：无 / 导出日期 */
  header: 'none' | 'title';
  footer: 'none' | 'date';
}

export const defaultExportPrefs: ExportPrefs = { paper: 'A4', margin: 20, header: 'none', footer: 'none' };

const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

export function sanitizeImagePrefs(raw: unknown): ImagePrefs {
  const s = (raw ?? {}) as Partial<ImagePrefs>;
  const d = defaultImagePrefs;
  return {
    save: oneOf(s.save, ['template', 'none'] as const, d.save),
    template: str(s.template, d.template).trim() || d.template,
    upload: oneOf(s.upload, ['none', 'picgo', 'command'] as const, d.upload),
    picgoUrl: str(s.picgoUrl, d.picgoUrl).trim() || d.picgoUrl,
    command: str(s.command, d.command),
  };
}

export function sanitizeExportPrefs(raw: unknown): ExportPrefs {
  const s = (raw ?? {}) as Partial<ExportPrefs>;
  const d = defaultExportPrefs;
  return {
    paper: oneOf(s.paper, ['A4', 'Letter'] as const, d.paper),
    margin: typeof s.margin === 'number' && s.margin >= 0 && s.margin <= 50 ? s.margin : d.margin,
    header: oneOf(s.header, ['none', 'title'] as const, d.header),
    footer: oneOf(s.footer, ['none', 'date'] as const, d.footer),
  };
}

/** 用户改过的快捷键（只存和默认不同的）；空字符串表示去掉这个快捷键 */
export type KeymapOverrides = Partial<Record<CommandId, string>>;

export function sanitizeKeymap(raw: unknown): KeymapOverrides {
  if (!raw || typeof raw !== 'object') return {};
  const out: KeymapOverrides = {};
  for (const [id, v] of Object.entries(raw)) {
    if (id in defaultKeymap && typeof v === 'string' && v !== defaultKeymap[id as CommandId]) out[id as CommandId] = v;
  }
  return out;
}

export function effectiveKeymap(overrides: KeymapOverrides): Record<CommandId, string> {
  return { ...defaultKeymap, ...overrides };
}
