/**
 * Zyrite 内置主题 token。
 *
 * 三套主题（2026-11-12 改版）：
 * - 石墨 graphite：深色，像一台安静的仪器；唯一强调色冷青
 * - 冷白 frost：浅色，精密的细线和等宽数字；唯一强调色电蓝
 * - 信号 signal：深色侧栏、标题栏、状态栏 + 浅色正文；AI 相关的地方只用琥珀一种信号色
 * 旧版的纸、墨、宣、青、素由 migrateThemeId 换成新主题。
 */

export type ThemeId = 'graphite' | 'frost' | 'signal';

/** 旧版主题 id → 新主题（读旧设置时用） */
const LEGACY_THEMES: Record<string, ThemeId> = {
  paper: 'frost',
  xuan: 'frost',
  celadon: 'frost',
  mono: 'frost',
  ink: 'graphite',
};

/** 审阅用色。颜色之外必须同时有 `+ − !` 符号或删除线，不能只靠颜色区分。 */
export interface ReviewColors {
  /** 新增行底色 */
  addBg: string;
  /** 新增文字 / 符号 */
  addText: string;
  /** 删除行底色 */
  delBg: string;
  /** 删除符号 */
  delText: string;
  /** 冲突 */
  conflict: string;
}

/** 代码块语法高亮。克制的低饱和配色，正文仍是主角；对比度在代码底色上 ≥ 4.5 */
export interface SyntaxColors {
  keyword: string;
  string: string;
  /** 数字、布尔、null 等字面量 */
  number: string;
  comment: string;
  /** 函数名、定义、属性 */
  def: string;
  /** 类型、类名、命名空间、HTML 标签 */
  type: string;
}

export interface ThemeColors {
  /** 正文底 */
  bg: string;
  /** 文字 */
  text: string;
  /** 次要文字 */
  muted: string;
  /** 1px 分隔线 */
  hair: string;
  /** 链接 / 强调 */
  accent: string;
  /** 链接下划线 */
  linkLine: string;
  /** 选中行 */
  sel: string;
  /** 代码底 */
  code: string;
  /** AI / Agent 相关：Agent 名字、正在写入、批注编号、主按钮 */
  ai: string;
  /** ai 底上的文字（主按钮） */
  onAi: string;
  /** 侧栏 / 标题栏 / 状态栏的底（完整版） */
  side: string;
  /** 侧栏里的文字、次要文字、分隔线、选中行、强调、AI 色；信号主题的侧栏是深色，和正文分开 */
  sideText: string;
  sideMuted: string;
  sideHair: string;
  sideSel: string;
  sideAccent: string;
  sideAi: string;
}

export interface Theme {
  id: ThemeId;
  name: { 'zh-CN': string; en: string };
  dark: boolean;
  colors: ThemeColors;
  review: ReviewColors;
  syntax: SyntaxColors;
  /** 正文字体栈 */
  fontBody: string;
}

/** 界面字体（标题栏、侧栏、状态栏等），所有主题一致 */
export const FONT_UI = "'Inter Variable', Inter, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif";
export const FONT_MONO =
  "'JetBrains Mono Variable', 'JetBrains Mono', 'PingFang SC', 'Microsoft YaHei', ui-monospace, monospace";
const FONT_SERIF = "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'SimSun', serif";

const SYNTAX_LIGHT: SyntaxColors = {
  keyword: '#7A3E8E',
  string: '#2F6A3A',
  number: '#8F4B12',
  comment: '#5F646A',
  def: '#24508F',
  type: '#1F6466',
};

const SYNTAX_DARK: SyntaxColors = {
  keyword: '#C3A9DA',
  string: '#C9B48A',
  number: '#E3B07D',
  comment: '#8B9299',
  def: '#9FB7C9',
  type: '#86C6BE',
};

export const themes: Record<ThemeId, Theme> = {
  graphite: {
    id: 'graphite',
    name: { 'zh-CN': '石墨', en: 'Graphite' },
    dark: true,
    colors: {
      bg: '#0F1113',
      text: '#D4D7DB',
      muted: '#8B9299',
      hair: '#23272C',
      accent: '#7FB8C4',
      linkLine: '#5F666D',
      sel: '#181B1F',
      code: '#15181B',
      ai: '#7FB8C4',
      onAi: '#0B0C0E',
      side: '#0B0C0E',
      sideText: '#D4D7DB',
      sideMuted: '#8B9299',
      sideHair: '#23272C',
      sideSel: '#181B1F',
      sideAccent: '#7FB8C4',
      sideAi: '#7FB8C4',
    },
    review: {
      addBg: '#15241C',
      addText: '#93C9A8',
      delBg: '#24181A',
      delText: '#D99A9F',
      conflict: '#E2AA55',
    },
    syntax: SYNTAX_DARK,
    fontBody: FONT_UI,
  },
  frost: {
    id: 'frost',
    name: { 'zh-CN': '冷白', en: 'Frost' },
    dark: false,
    colors: {
      bg: '#F6F7F8',
      text: '#15171A',
      muted: '#5B6168',
      hair: '#DADDE1',
      accent: '#2F5BEA',
      linkLine: '#C9D3F5',
      sel: '#E3E6EA',
      code: '#EEF0F2',
      ai: '#2F5BEA',
      onAi: '#FFFFFF',
      side: '#EEF0F2',
      sideText: '#15171A',
      sideMuted: '#5B6168',
      sideHair: '#DADDE1',
      sideSel: '#E1E5EA',
      sideAccent: '#2F5BEA',
      sideAi: '#2F5BEA',
    },
    review: {
      addBg: '#E3F2E8',
      addText: '#1A6E37',
      delBg: '#F8E5E5',
      delText: '#B42318',
      conflict: '#8A5300',
    },
    syntax: SYNTAX_LIGHT,
    fontBody: FONT_UI,
  },
  signal: {
    id: 'signal',
    name: { 'zh-CN': '信号', en: 'Signal' },
    dark: false,
    colors: {
      bg: '#FAFAF8',
      text: '#1B1C1E',
      muted: '#5F6368',
      hair: '#E4E4E0',
      accent: '#2A2C2F',
      linkLine: '#B4B8BC',
      sel: '#ECECE8',
      code: '#F0F0EC',
      ai: '#9A5B00',
      onAi: '#FFFFFF',
      side: '#121314',
      sideText: '#D8DADC',
      sideMuted: '#8A8F94',
      sideHair: '#26282B',
      sideSel: '#1E2022',
      sideAccent: '#ECEEF0',
      sideAi: '#E0A040',
    },
    review: {
      addBg: '#E1EEE3',
      addText: '#24603A',
      delBg: '#F6E2DF',
      delText: '#8C2F24',
      conflict: '#8A5300',
    },
    syntax: SYNTAX_LIGHT,
    fontBody: FONT_SERIF,
  },
};

/** 状态栏"主题"按钮的切换顺序 */
export const themeOrder: readonly ThemeId[] = ['frost', 'graphite', 'signal'];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (themeOrder as readonly string[]).includes(value);
}

/** 读设置里的主题：新 id 原样返回，旧版的纸、墨、宣、青、素换成对应的新主题，其余返回 null */
export function migrateThemeId(value: unknown): ThemeId | null {
  if (isThemeId(value)) return value;
  return typeof value === 'string' ? (LEGACY_THEMES[value] ?? null) : null;
}

export function nextThemeId(id: ThemeId): ThemeId {
  const i = themeOrder.indexOf(id);
  return themeOrder[(i + 1) % themeOrder.length] ?? 'frost';
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * 把主题转成 CSS 变量，例如 `--z-bg`、`--z-link-line`、`--z-review-add-bg`、`--z-syn-keyword`、`--z-font-body`。
 */
export function themeToCssVars(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme.colors)) vars[`--z-${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(theme.review)) vars[`--z-review-${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(theme.syntax)) vars[`--z-syn-${kebab(k)}`] = v;
  vars['--z-font-body'] = theme.fontBody;
  vars['--z-font-ui'] = FONT_UI;
  vars['--z-font-mono'] = FONT_MONO;
  return vars;
}

/** WCAG 2.x 相对亮度 */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) throw new Error(`不是 #RRGGBB 色值：${hex}`);
  const n = parseInt(m[1], 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2.x 对比度，范围 1–21 */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
