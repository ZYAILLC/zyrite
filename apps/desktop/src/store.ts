import { migrateThemeId, nextThemeId, type ThemeId } from '@zyrite/themes';
import { create } from 'zustand';
import type { Annotation, McpAccess, NoteName, Stamp, TreeEntry } from './lib/backend';
import { type AiSettings, defaultAi, sanitizeAi } from './lib/aiConfig';
import { type CommandId, defaultKeymap, formatBinding } from './lib/keymap';
import { isMac } from './lib/platform';
import {
  defaultExportPrefs,
  defaultImagePrefs,
  type ExportPrefs,
  type ImagePrefs,
  type KeymapOverrides,
  sanitizeExportPrefs,
  sanitizeImagePrefs,
  sanitizeKeymap,
} from './lib/prefs';
import type { MergeState, ReviewState } from './lib/review';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Edition = 'simple' | 'full';
/** 只开原文时原文栏的样子：纯源码（等宽、只高亮语法），或实时预览（非光标行渲染成正文） */
export type SoloSource = 'plain' | 'live';
export type SidebarPage = 'files' | 'doc';
/**
 * 实际用哪种编辑器：
 * - source：纯源码（原文 + 预览分栏时的原文栏，或只开原文且选了纯源码）
 * - live：实时预览（只开原文且选了实时预览）
 * - wysiwyg：所见即所得（只开预览时，预览可直接编辑）
 */
export type EditorKind = 'source' | 'live' | 'wysiwyg';

export interface ThemePref {
  /** 跟随系统深浅色 */
  followSystem: boolean;
  /** 不跟随系统时使用 */
  theme: ThemeId;
  /** 跟随系统时，浅色用 */
  light: ThemeId;
  /** 跟随系统时，深色用 */
  dark: ThemeId;
}

interface Settings {
  edition: Edition;
  /** 中间显示原文、右边显示预览；至少开一个 */
  showSource: boolean;
  showPreview: boolean;
  soloSource: SoloSource;
  /** 左栏显示"文件"还是"目录"（文档的标题大纲） */
  sidebarPage: SidebarPage;
  themePref: ThemePref;
  /** 专注模式：当前段落以外变淡 */
  focusMode: boolean;
  /** 打字机模式：光标所在行保持在垂直居中 */
  typewriter: boolean;
  /** 最近打开的文件，最新的在前 */
  recent: string[];
  /** 打开应用时用简洁版还是完整版（设置 › 通用） */
  defaultEdition: Edition;
  /** 界面语言；system 跟随系统 */
  language: 'system' | 'zh-CN' | 'en';
  /** 正文字号（px）和最大宽度（px） */
  fontSize: number;
  lineWidth: number;
  /** 正文行高（倍数） */
  lineHeight: number;
  /** 图片、导出、快捷键 */
  image: ImagePrefs;
  exportPrefs: ExportPrefs;
  keymap: KeymapOverrides;
  /** 导入的 Typora 主题名（null 用内置主题） */
  typoraTheme: string | null;
  /** Agent 写入时审阅视图自动滚动跟随（可关） */
  followWriting: boolean;
  /** 内置 AI 的模型设置（key 在系统钥匙串里，不在这里） */
  ai: AiSettings;
  /** 文件树里展开的文件夹（相对路径），以及它属于哪个库；换库时清空 */
  expanded: Record<string, boolean>;
  expandedFor: string | null;
}

export const RECENT_LIMIT = 20;

export type PaletteMode = 'all' | 'files' | 'search' | 'tag';

export type SettingsTab = 'general' | 'theme' | 'ai' | 'mcp' | 'image' | 'export' | 'shortcuts';

export interface PaletteState {
  mode: PaletteMode;
  /** tag 模式：列出这个标签下的笔记 */
  tag?: string;
}

/** 查找栏：open 时显示；replace 时多一行替换；seq 每次 ⌘F 加 1，用来重新聚焦输入框 */
export interface FindUi {
  open: boolean;
  replace: boolean;
  seq: number;
}

/** 一份打开的文档。编辑器本身才是实时内容，这里的 text 是编辑后防抖同步的快照（字数、大纲用） */
export interface DocState {
  /** 文件路径；新建还没保存的文档为 null */
  filePath: string | null;
  text: string;
  /** 磁盘上（上次打开或保存时）的内容，用来判断有没有未保存的修改 */
  savedText: string;
  /** 上次打开或保存时文件的戳，保存时用来发现外部修改 */
  stamp: Stamp | null;
  dirty: boolean;
}

export interface Notice {
  text: string;
  error?: boolean;
  /** 显示多久（毫秒）；默认普通提示 2.5 秒、出错 8 秒 */
  durationMs?: number;
}

interface AppState extends Settings, DocState {
  systemDark: boolean;
  /** 每换一份文档（打开、新建、还原）加 1，编辑器据此重建 */
  docId: number;
  /** 状态栏里的一行提示（已保存、出错等），几秒后消失 */
  notice: Notice | null;
  /** 打开的文件夹（⌘P 在这里找文件）；没打开时用当前文件所在目录 */
  folder: string | null;
  find: FindUi;
  /** 设置页打开时显示哪一类；null 表示关着 */
  settingsTab: SettingsTab | null;
  /** 弹出的面板：⌘K 命令面板、⌘P 快速打开、⌘⇧F 全文搜索、按标签列出笔记 */
  palette: PaletteState | null;
  /** 打开的文件夹的文件树；没打开文件夹时为 null */
  tree: TreeEntry[] | null;
  /** 当前文件待审阅的 Agent 改动；没有时为 null */
  review: ReviewState | null;
  /** 审阅时当前聚焦的是第几处 */
  reviewFocus: number;
  /** 有未保存修改时外部写入产生的冲突，等用户在"并排合并"里选择 */
  merge: MergeState | null;
  /** .zyrite 里的 Agent 数据（已连接的 Agent、活动记录）每次变化加 1 */
  agentVersion: number;
  /** .zyrite/annotations 每次变化加 1 */
  annotationVersion: number;
  /** 当前库的 MCP 接入授权和等待处理的授权请求（.zyrite/grants.json、requests/） */
  access: McpAccess;
  /** 当前文件的批注 */
  annotations: Annotation[];
  /** 批注列表的筛选 */
  annFilter: 'all' | 'open' | 'changed' | 'resolved';
  /** 批注显示在正文右侧（边注）还是左栏文档页 */
  annMargin: boolean;
  /** 选中文字后点了"AI 改写"（components/AiRewrite 处理） */
  aiRewrite: { selection: { text: string; prefix: string; suffix: string; rect: { left: number; top: number; right: number; bottom: number } } } | null;
  /** 正在写的新批注（选中文字后点"批注给 Agent"） */
  composer: { anchor: { text: string; prefix: string; suffix: string }; top: number } | null;
  /** 索引里的笔记名单（双链解析、补全）；没打开库或索引没建好时为 null */
  noteNames: NoteName[] | null;
  /** 索引每次更新加 1，反向链接、标签等面板据此重新查询 */
  indexVersion: number;
  /** 正在文件树里改名的条目（绝对路径） */
  renaming: string | null;
  /** 最近一次换文档时是否保留光标和滚动位置（外部修改后重新载入同一个文件） */
  keepView: boolean;
  setEdition: (edition: Edition) => void;
  toggleEdition: () => void;
  /** 开关原文、预览；关掉唯一开着的那个时，另一个自动打开 */
  toggleSource: () => void;
  togglePreview: () => void;
  toggleFocusMode: () => void;
  toggleTypewriter: () => void;
  /** 状态栏"主题"按钮：按固定顺序切到下一套，并停止跟随系统 */
  cycleTheme: () => void;
  setSystemDark: (dark: boolean) => void;
  setText: (text: string) => void;
  /** 换一份文档；keepView 时编辑器保留光标所在块和滚动位置 */
  loadDoc: (doc: DocState, opts?: { keepView?: boolean }) => void;
  /** 当前文件被改名或移动 */
  setFilePath: (path: string) => void;
  setTree: (tree: TreeEntry[] | null) => void;
  setExpanded: (path: string, open: boolean) => void;
  setRenaming: (path: string | null) => void;
  markEdited: () => void;
  markSaved: (path: string, savedText: string, stamp: Stamp, dirty: boolean) => void;
  setNotice: (notice: Notice | null) => void;
  setFolder: (folder: string | null) => void;
  addRecent: (path: string) => void;
  openFind: (replace: boolean) => void;
  closeFind: () => void;
  /** ⌘P 快速打开；带 tag 时只列这个标签下的笔记 */
  setQuickOpen: (open: boolean, tag?: string | null) => void;
  openPalette: (mode: PaletteMode, tag?: string) => void;
  closePalette: () => void;
}

export const defaultSettings: Settings = {
  edition: 'full',
  showSource: true,
  showPreview: true,
  soloSource: 'live',
  sidebarPage: 'files',
  themePref: { followSystem: false, theme: 'frost', light: 'frost', dark: 'graphite' },
  focusMode: false,
  typewriter: false,
  recent: [],
  defaultEdition: 'full',
  language: 'system',
  fontSize: 16,
  lineWidth: 720,
  lineHeight: 1.8,
  image: defaultImagePrefs,
  exportPrefs: defaultExportPrefs,
  keymap: {},
  typoraTheme: null,
  followWriting: true,
  ai: defaultAi,
  expanded: {},
  expandedFor: null,
};

export function activeThemeId(pref: ThemePref, systemDark: boolean): ThemeId {
  if (!pref.followSystem) return pref.theme;
  return systemDark ? pref.dark : pref.light;
}

/** 本地存储里的设置可能来自旧版本或被手改过，逐项校验，不合法就用默认值 */
export function sanitizeSettings(raw: unknown): Settings {
  const s = (raw ?? {}) as Partial<Settings>;
  const p = (s.themePref ?? {}) as Partial<ThemePref>;
  const d = defaultSettings;
  return {
    edition: s.edition === 'simple' || s.edition === 'full' ? s.edition : d.edition,
    ...normalizePanes(
      typeof s.showSource === 'boolean' ? s.showSource : d.showSource,
      typeof s.showPreview === 'boolean' ? s.showPreview : d.showPreview,
    ),
    soloSource: s.soloSource === 'plain' || s.soloSource === 'live' ? s.soloSource : d.soloSource,
    sidebarPage: s.sidebarPage === 'files' || s.sidebarPage === 'doc' ? s.sidebarPage : d.sidebarPage,
    themePref: {
      followSystem: typeof p.followSystem === 'boolean' ? p.followSystem : d.themePref.followSystem,
      // 旧版的纸、墨、宣、青、素换成新主题（themes 的 migrateThemeId）
      theme: migrateThemeId(p.theme) ?? d.themePref.theme,
      light: migrateThemeId(p.light) ?? d.themePref.light,
      dark: migrateThemeId(p.dark) ?? d.themePref.dark,
    },
    focusMode: typeof s.focusMode === 'boolean' ? s.focusMode : d.focusMode,
    typewriter: typeof s.typewriter === 'boolean' ? s.typewriter : d.typewriter,
    recent: Array.isArray(s.recent)
      ? s.recent.filter((p): p is string => typeof p === 'string').slice(0, RECENT_LIMIT)
      : d.recent,
    expanded:
      s.expanded && typeof s.expanded === 'object'
        ? Object.fromEntries(Object.entries(s.expanded).filter(([, v]) => v === true))
        : d.expanded,
    expandedFor: typeof s.expandedFor === 'string' ? s.expandedFor : d.expandedFor,
    defaultEdition: s.defaultEdition === 'simple' || s.defaultEdition === 'full' ? s.defaultEdition : d.defaultEdition,
    language: s.language === 'zh-CN' || s.language === 'en' ? s.language : d.language,
    fontSize: typeof s.fontSize === 'number' && s.fontSize >= 12 && s.fontSize <= 24 ? s.fontSize : d.fontSize,
    lineWidth: typeof s.lineWidth === 'number' && s.lineWidth >= 560 && s.lineWidth <= 1200 ? s.lineWidth : d.lineWidth,
    lineHeight: typeof s.lineHeight === 'number' && s.lineHeight >= 1.2 && s.lineHeight <= 2.4 ? s.lineHeight : d.lineHeight,
    image: sanitizeImagePrefs(s.image),
    exportPrefs: sanitizeExportPrefs(s.exportPrefs),
    keymap: sanitizeKeymap(s.keymap),
    typoraTheme: typeof s.typoraTheme === 'string' && s.typoraTheme ? s.typoraTheme : null,
    followWriting: typeof s.followWriting === 'boolean' ? s.followWriting : d.followWriting,
    ai: sanitizeAi(s.ai),
  };
}

/** 原文和预览不能都关：都关时只留原文 */
function normalizePanes(showSource: boolean, showPreview: boolean) {
  return showSource || showPreview ? { showSource, showPreview } : { showSource: true, showPreview: false };
}

export function editorKind(s: Pick<Settings, 'showSource' | 'showPreview' | 'soloSource'>): EditorKind {
  if (!s.showSource) return 'wysiwyg';
  if (s.showPreview) return 'source';
  return s.soloSource === 'plain' ? 'source' : 'live';
}

const prefersDark = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      ...defaultSettings,
      systemDark: prefersDark(),
      filePath: null,
      text: '',
      savedText: '',
      stamp: null,
      dirty: false,
      docId: 0,
      notice: null,
      folder: null,
      find: { open: false, replace: false, seq: 0 },
      palette: null,
      settingsTab: null,
      tree: null,
      renaming: null,
      keepView: false,
      noteNames: null,
      indexVersion: 0,
      review: null,
      reviewFocus: 0,
      merge: null,
      agentVersion: 0,
      annotationVersion: 0,
      access: { grants: [], requests: [] },
      annotations: [],
      annFilter: 'all',
      annMargin: false,
      aiRewrite: null,
      composer: null,
      setEdition: (edition) => set({ edition }),
      toggleEdition: () => set({ edition: get().edition === 'full' ? 'simple' : 'full' }),
      toggleSource: () => {
        const { showSource, showPreview } = get();
        set(showSource && !showPreview ? { showSource: false, showPreview: true } : { showSource: !showSource });
      },
      togglePreview: () => {
        const { showSource, showPreview } = get();
        set(showPreview && !showSource ? { showPreview: false, showSource: true } : { showPreview: !showPreview });
      },
      toggleFocusMode: () => set({ focusMode: !get().focusMode }),
      toggleTypewriter: () => set({ typewriter: !get().typewriter }),
      cycleTheme: () => {
        const { themePref, systemDark } = get();
        const next = nextThemeId(activeThemeId(themePref, systemDark));
        set({ themePref: { ...themePref, followSystem: false, theme: next }, typoraTheme: null });
      },
      setSystemDark: (systemDark) => set({ systemDark }),
      setText: (text) => set({ text, dirty: text !== get().savedText }),
      loadDoc: (doc, opts) => set({ ...doc, docId: get().docId + 1, keepView: !!opts?.keepView }),
      setFilePath: (filePath) => set({ filePath }),
      setTree: (tree) => set({ tree }),
      setExpanded: (path, open) => set({ expanded: { ...get().expanded, [path]: open } }),
      setRenaming: (renaming) => set({ renaming }),
      markEdited: () => {
        if (!get().dirty) set({ dirty: true });
      },
      markSaved: (filePath, savedText, stamp, dirty) => set({ filePath, savedText, stamp, dirty }),
      setNotice: (notice) => set({ notice }),
      setFolder: (folder) =>
        set(folder === get().expandedFor ? { folder } : { folder, expanded: {}, expandedFor: folder }),
      addRecent: (path) => set({ recent: [path, ...get().recent.filter((p) => p !== path)].slice(0, RECENT_LIMIT) }),
      openFind: (replace) => set({ find: { open: true, replace: replace || get().find.replace, seq: get().find.seq + 1 } }),
      closeFind: () => set({ find: { ...get().find, open: false } }),
      setQuickOpen: (open, tag = null) => set({ palette: open ? (tag ? { mode: 'tag', tag } : { mode: 'files' }) : null }),
      openPalette: (mode, tag) => set({ palette: { mode, tag } }),
      closePalette: () => set({ palette: null }),
    }),
    {
      name: 'zyrite.settings',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s): Settings => ({
        edition: s.edition,
        showSource: s.showSource,
        showPreview: s.showPreview,
        soloSource: s.soloSource,
        sidebarPage: s.sidebarPage,
        themePref: s.themePref,
        focusMode: s.focusMode,
        typewriter: s.typewriter,
        recent: s.recent,
        defaultEdition: s.defaultEdition,
        language: s.language,
        fontSize: s.fontSize,
        lineWidth: s.lineWidth,
        lineHeight: s.lineHeight,
        image: s.image,
        exportPrefs: s.exportPrefs,
        keymap: s.keymap,
        typoraTheme: s.typoraTheme,
        followWriting: s.followWriting,
        ai: s.ai,
        // 只存展开的，收起的不占地方
        expanded: Object.fromEntries(Object.entries(s.expanded).filter(([, v]) => v)),
        expandedFor: s.expandedFor,
      }),
      // 启动时按设置里的"打开时使用"选版本（版本本身不跨次记住）
      merge: (persisted, current) => {
        const saved = sanitizeSettings(persisted);
        return { ...current, ...saved, edition: saved.defaultEdition };
      },
    },
  ),
);

/** 某个命令当前的快捷键（keymap 写法；用户去掉了就是空字符串） */
export function bindingOf(id: CommandId): string {
  return useApp.getState().keymap[id] ?? defaultKeymap[id];
}

/** 组件里显示快捷键：改了快捷键后跟着刷新 */
export function useBinding(id: CommandId): string {
  const b = useApp((s) => s.keymap[id] ?? defaultKeymap[id]);
  return b ? formatBinding(b, isMac) : '';
}
