/** 查找替换：两种编辑器各自实现，界面（FindBar）共用 */
export interface FindQuery {
  search: string;
  replace: string;
  caseSensitive: boolean;
  regexp: boolean;
}

export interface FindAdapter {
  /** 设置查询，返回匹配数和当前是第几个（从 1 开始，0 表示光标不在匹配上） */
  setQuery(q: FindQuery): { count: number; current: number };
  next(): { count: number; current: number };
  prev(): { count: number; current: number };
  replace(): { count: number; current: number };
  replaceAll(): number;
  /** 关闭查找：清除高亮，把焦点还给正文 */
  close(): void;
}

/** 把 Markdown 里的图片地址转成可以显示的 URL（本地相对路径要经过 Tauri asset 协议） */
export type ResolveUrl = (src: string) => string;

/** 编辑器里的界面文案，由应用按语言传入 */
export interface EditorLabels {
  /** frontmatter 折叠后的一行，例如"属性 · 3 项" */
  frontmatter: (count: number) => string;
  /** 代码块语言输入框的占位 */
  language: string;
}

export const defaultLabels: EditorLabels = {
  frontmatter: (n) => `Properties · ${n}`,
  language: 'language',
};

import type { AnnotationMark, SelectionInfo } from './annotate';

/** 两种编辑器对外的统一接口 */
export interface EditorHandle {
  /** 当前全文（所见即所得会做块级回写） */
  getText(): string;
  /** 选中的文字（第一个选区），没有选中时为空串；查找时用来预填 */
  getSelectedText(): string;
  /** 光标所在的顶层块序号，用于切换模式时定位 */
  getCursorBlock(): number;
  /** 光标移到第 index 个顶层块开头，并滚动到可见 */
  setCursorBlock(index: number): void;
  /**
   * 在指定的屏幕坐标处（没有坐标时在光标处）插入一段 Markdown，插入后光标放在它后面。
   * 拖入文件生成链接时用；所见即所得会把 Markdown 解析成节点再插入。
   */
  insertMarkdown(markdown: string, at?: { x: number; y: number }): void;
  /** 滚动到源码偏移所在的块（大纲跳转） */
  revealOffset(offset: number): void;
  focus(): void;
  /** 光标放到文末并聚焦（点正文下方的空白处） */
  focusEnd(): void;
  /** 选中的文字、前后文和位置；没有选中时为 null（新建批注、AI 改写用） */
  getSelectionInfo(): SelectionInfo | null;
  /** 用新内容替换选中的文字（AI 改写的"替换"）；after 为 true 时插到选区后面 */
  replaceSelection(text: string, after?: boolean): void;
  /**
   * 在选中文字前后插入源码（比如文字颜色的 `<span style="color:…">` 和 `</span>`），选中的内容和格式不变。
   * 所见即所得里选区跨了多个块时不处理，返回 false。
   */
  wrapSelection?(before: string, after: string): boolean;
  /** 标出批注：对应文字加下划线，后面加上标编号 */
  setAnnotations(marks: AnnotationMark[]): void;
  /** 各条批注的锚点在窗口里的纵坐标（边注对齐用）；找不到位置的不在结果里 */
  annotationTops(): Record<string, number>;
  /** 滚动到批注的位置 */
  revealAnnotation(id: string): void;
  /** 库里的笔记变了（新建、删除、改名），重新判断双链是否存在 */
  refreshLinks(): void;
  setFocusMode(on: boolean): void;
  setTypewriter(on: boolean): void;
  /**
   * 窗口纵坐标 clientY 处是源码第几行（从 1 开始），fraction 是在这一行里的比例（0–1）。
   * 原文和预览分栏时同步滚动用；只有源码编辑器实现。
   */
  lineAt?(clientY: number): { line: number; fraction: number } | null;
  /** 源码第 line 行（从 1 开始）在窗口里的纵坐标和高度；超出范围时为 null */
  lineRect?(line: number): { top: number; height: number } | null;
  find: FindAdapter;
  destroy(): void;
}

/**
 * `![[目标]]` 嵌入的内容：图片（`![[a.png|200]]` 可带宽度或 `宽x高`）、视频或音频（`![[clip.mp4]]`，显示播放器），
 * 或另一篇笔记（`![[笔记#标题]]` 只嵌入那一节）。笔记内容异步读取，调用方负责截取标题对应的那一节。
 */
export type EmbedInfo =
  | { kind: 'image'; src: string; alt: string; width?: number; height?: number }
  | { kind: 'media'; media: 'video' | 'audio'; src: string; alt: string; width?: number; height?: number }
  | { kind: 'note'; title: string; load: () => Promise<string>; resolveUrl?: ResolveUrl };

/** 解析 `![[…]]` 里的内容（不含 `![[` `]]`）；解析不了返回 null，照常显示成链接 */
export type ResolveEmbed = (value: string) => EmbedInfo | null;

/** 双链目标的状态：库里有这篇笔记、没有（显示成虚线）、附件或无法判断（照常显示） */
export type LinkStatusFn = (target: string) => 'note' | 'missing' | 'other';

export interface EditorOptions {
  parent: HTMLElement;
  source: string;
  /**
   * 源码编辑器（editor-live）是否渲染：true（默认）为实时预览，非光标行渲染成正文；
   * false 为纯源码，只做语法高亮，用于"原文 + 预览"分栏的原文栏。所见即所得忽略这一项。
   */
  rendered?: boolean;
  /** 内容变化（防抖由调用方处理） */
  onChange?: () => void;
  resolveUrl?: ResolveUrl;
  /** 点击链接（含双链）；不传则不处理 */
  onOpenLink?: (href: string, kind: 'url' | 'wikilink') => void;
  placeholder?: string;
  labels?: Partial<EditorLabels>;
  /** 判断双链 `[[目标]]` 是否存在；不传则都按存在显示 */
  linkStatus?: LinkStatusFn;
  /** 解析 `![[…]]` 嵌入（图片、笔记）；不传则嵌入显示成链接 */
  resolveEmbed?: ResolveEmbed;
  /** 输入 `[[` 后的笔记补全；不传则不弹 */
  completeLinks?: (query: string) => { label: string; detail?: string; insert: string }[];
  /** 粘贴了图片（文件，或 blob:/data: 地址）：返回 true 表示已处理，编辑器不再插入 */
  onPasteFiles?: (images: PastedImage[]) => boolean;
  /** 粘贴事件里网页读不到任何数据（WebKitGTK 粘贴图片时就是这样）：返回 true 表示交给应用从系统剪贴板读 */
  onPasteEmpty?: () => boolean;
}

/** 粘贴进来的图片：文件，或者 WebView 给的 blob:/data: 地址 */
export type PastedImage = File | string;

/**
 * 剪贴板里的图片。有的 WebView 把图片放在 files 里，有的只放在 items 里，
 * WebKitGTK 则给一段 `<img src="blob:…">` 的 HTML；这几种都认。
 */
export function clipboardFiles(data: DataTransfer | null): PastedImage[] {
  if (!data) return [];
  if (data.files?.length) return [...data.files];
  const fromItems = [...(data.items ?? [])]
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
  if (fromItems.length) return fromItems;
  const html = data.getData('text/html');
  if (!html) return [];
  const srcs = [...html.matchAll(/<img\b[^>]*\bsrc=["']((?:blob|data):[^"']+)["']/gi)].map((m) => m[1]!);
  // 只有图片、没有别的文字内容时才当成粘贴图片
  const rest = html
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\s\uFFFC]+/g, '');
  return srcs.length && !rest ? srcs : [];
}
