import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask, message, open, save } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { type Locale, t } from '../i18n';
import { useApp } from '../store';
import { dirname, isUrl, resolvePath } from './paths';
import { isTauri } from './platform';
import { allowImage, type ImagePrefs } from './prefs';

/**
 * 界面和系统之间的一层：文件读写、对话框、恢复缓存。
 * Tauri 里走 Rust 命令（crates/zyrite-core）；`pnpm dev:web` 在浏览器里调试时用 localStorage 模拟。
 */

/** 文件在磁盘上的状态（修改时间 + 大小），保存时用来发现外部修改 */
export interface Stamp {
  modifiedMs: number;
  len: number;
}

export interface LoadedFile {
  path: string;
  text: string;
  stamp: Stamp;
}

export interface Session {
  path: string | null;
  text: string | null;
  stamp: Stamp | null;
  updatedMs: number;
  /** 打开的文件夹；旧版本的会话里没有 */
  folder?: string | null;
}

export type FileErrorKind = 'notFound' | 'notUtf8' | 'conflict' | 'exists' | 'io';

/** 文件树条目：相对库根目录的路径，分隔符为 `/` */
export interface TreeEntry {
  path: string;
  dir: boolean;
}

/** 文件监听报告的变化（绝对路径） */
export interface FsChange {
  path: string;
  kind: 'create' | 'modify' | 'remove';
  dir: boolean;
}

/** 索引里的笔记名单：双链补全和解析用 */
export interface NoteName {
  /** 相对库根目录 */
  rel: string;
  stem: string;
  title: string | null;
  aliases: string[];
}

export interface Mention {
  /** 相对库根目录 */
  from: string;
  line: number;
  context: string;
}

export interface Backlinks {
  linked: Mention[];
  unlinked: Mention[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface SearchMatch {
  line: number;
  before: string;
  text: string;
  after: string;
}

export interface SearchHit {
  /** 相对库根目录 */
  rel: string;
  title: string | null;
  count: number;
  matches: SearchMatch[];
}

export interface SearchResult {
  hits: SearchHit[];
  totalNotes: number;
  totalMatches: number;
  elapsedMs: number;
}

/** MCP write_note 写入的待审阅内容 */
export interface QueueItem {
  id: string;
  /** 相对库根目录 */
  path: string;
  content: string;
  agent: string;
  reason: string;
  createdMs: number;
}

export interface ReviewData {
  baseline: string | null;
  queued: QueueItem | null;
}

export type AnnotationStatus = 'open' | 'changed' | 'resolved';

export interface Annotation {
  id: string;
  /** 相对库根目录 */
  file: string;
  anchor: { text: string; prefix: string; suffix: string };
  body: string;
  /** 交给哪个 Agent；any 表示任意已连接的 Agent */
  assignee: string;
  status: AnnotationStatus;
  thread: { by: string; at: string; text: string }[];
  createdAt: string;
}

export interface AgentInfo {
  pid: number;
  name: string;
  startedMs: number;
  lastSeenMs: number;
}

export interface Activity {
  atMs: number;
  agent: string;
  action: string;
  path?: string;
  detail?: string;
  added: number;
  removed: number;
}

export interface VaultConfig {
  review: { enabled: boolean };
  mcp: { read: boolean; write: boolean; directWrite: boolean };
}

export type DataKind = 'queue' | 'annotations' | 'activity' | 'agents' | 'config' | 'grants' | 'requests';

/** MCP 接入授权：某个程序可以访问当前库 */
export interface McpGrant {
  id: string;
  name: string;
  /** 启动 MCP 的程序路径 */
  exe: string;
  write: boolean;
  directWrite: boolean;
  createdMs: number;
  /** 签名有效；无效的授权（被改过、从别的库复制来的）不起作用 */
  valid: boolean;
  lastAccessMs?: number | null;
}

/** 等用户允许或拒绝的授权请求 */
export interface McpAccessRequest {
  id: string;
  name: string;
  exe: string;
  pid: number;
  createdMs: number;
}

export interface McpAccess {
  grants: McpGrant[];
  requests: McpAccessRequest[];
}

export interface AiProvider {
  id: string;
  name: string;
  kind: 'openai' | 'ollama';
  baseUrl: string;
  model: string;
}

export interface AiEvent {
  id: string;
  delta?: string;
  text?: string;
  error?: string;
  done: boolean;
}

export interface AiPassage {
  rel: string;
  line: number;
  heading: string;
  text: string;
  score: number;
}

export interface WatchSpec {
  path: string;
  recursive: boolean;
}

export class FileError extends Error {
  constructor(
    readonly kind: FileErrorKind,
    message: string,
    readonly current?: Stamp,
  ) {
    super(message);
  }
}

export type UnsavedChoice = 'save' | 'discard' | 'cancel';
export type ConflictChoice = 'overwrite' | 'reload' | 'cancel';

export interface Backend {
  pickOpen(): Promise<string | null>;
  pickSave(defaultPath: string): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  /** 文件夹里的 Markdown 文件，相对路径、分隔符为 `/` */
  listMarkdown(root: string): Promise<string[]>;
  openFile(path: string): Promise<LoadedFile>;
  /** expected 为 null 时无条件覆盖 */
  saveFile(path: string, text: string, expected: Stamp | null): Promise<Stamp>;
  loadSession(): Promise<Session | null>;
  saveSession(session: Omit<Session, 'updatedMs'>): Promise<void>;
  launchPath(): Promise<string | null>;
  askUnsaved(name: string): Promise<UnsavedChoice>;
  askConflict(name: string): Promise<ConflictChoice>;
  showError(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  listTree(root: string, allFiles: boolean): Promise<TreeEntry[]>;
  /** 路径是不是文件夹（拖入时判断） */
  isDir(path: string): Promise<boolean>;
  createFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
  /** 改名或移动；updateLinks 时同时改写指向它的链接，返回被改写的文件 */
  renamePath(from: string, to: string, updateLinks: boolean): Promise<string[]>;
  /** 改名后要改写的链接数 */
  countLinkUpdates(from: string, to: string): Promise<number>;
  askUpdateLinks(name: string, count: number): Promise<'update' | 'skip' | 'cancel'>;
  /** 移到系统回收站 */
  trashPath(path: string): Promise<void>;
  /** 替换当前的文件监听；空数组停止 */
  watch(specs: WatchSpec[]): Promise<void>;
  /** 订阅文件变化，返回取消订阅 */
  onFsChanged(fn: (changes: FsChange[]) => void): Promise<() => void>;
  askTrash(name: string): Promise<boolean>;
  /** 打开库时后台建链接和标签索引；null 关闭 */
  indexOpen(root: string | null): Promise<void>;
  noteNames(): Promise<NoteName[]>;
  backlinks(path: string): Promise<Backlinks>;
  /** 全文搜索（语法见 crates/zyrite-core/src/search.rs） */
  search(query: string, limit: number): Promise<SearchResult>;
  tags(): Promise<TagCount[]>;
  /** 有这个标签（或子标签）的笔记，相对路径 */
  notesWithTag(tag: string): Promise<string[]>;
  onIndexChanged(fn: () => void): Promise<() => void>;
  // ---------- Agent 协作 ----------
  reviewGet(path: string): Promise<ReviewData>;
  /** null 删除基线 */
  baselineSet(path: string, text: string | null): Promise<void>;
  /** null 移出审阅队列 */
  queueSet(path: string, content: string | null): Promise<void>;
  queueList(): Promise<QueueItem[]>;
  annotationsGet(path: string): Promise<Annotation[]>;
  annotationsSave(path: string, list: Annotation[]): Promise<void>;
  agentsGet(): Promise<AgentInfo[]>;
  activityGet(limit: number): Promise<Activity[]>;
  vaultConfigGet(): Promise<VaultConfig>;
  vaultConfigSet(config: VaultConfig): Promise<void>;
  /** 本程序的路径（MCP 配置片段用） */
  mcpCommand(): Promise<string>;
  /** macOS 应用菜单：菜单文字跟随界面语言；点"设置…"时回调 */
  menuLocalize(settings: string): Promise<void>;
  /** 告诉 Rust 界面语言（报错文案用，也存下来给 MCP 服务用） */
  setLocale(locale: Locale): Promise<void>;
  onOpenSettings(fn: () => void): Promise<() => void>;
  /** 系统让 app 打开一个文件（app 已经开着时，在 Finder 里双击 .md） */
  onOpenPath(fn: (path: string) => void): Promise<() => void>;
  mcpAccessList(): Promise<McpAccess>;
  mcpAccessAnswer(id: string, allow: boolean): Promise<void>;
  mcpGrantSet(id: string, write: boolean, directWrite: boolean): Promise<void>;
  mcpGrantRevoke(id: string): Promise<void>;
  onDataChanged(fn: (kinds: DataKind[]) => void): Promise<() => void>;
  // ---------- 内置 AI ----------
  /** key 存进系统钥匙串（只写不读） */
  aiKeySet(id: string, key: string): Promise<void>;
  aiKeyHas(id: string): Promise<boolean>;
  aiKeyDelete(id: string): Promise<void>;
  /** 开始流式对话，输出通过 onAiEvent 推送 */
  aiChat(id: string, provider: AiProvider, keyId: string, messages: { role: string; content: string }[]): Promise<void>;
  aiCancel(id: string): Promise<void>;
  onAiEvent(fn: (e: AiEvent) => void): Promise<() => void>;
  /** 给库建向量索引，返回块数和新算的块数 */
  aiIndex(provider: AiProvider): Promise<{ chunks: number; embedded: number }>;
  onAiIndex(fn: (p: { done: number; total: number }) => void): Promise<() => void>;
  /** 问答检索：scope 是文件夹前缀或文件的相对路径 */
  aiRetrieve(question: string, scope: string | null, k: number, embed: AiProvider | null): Promise<AiPassage[]>;
  revealInDir(path: string): Promise<void>;
  /** 放行这些文件（或文件夹）所在目录里的图片显示 */
  allowAssetDirs(paths: string[]): Promise<void>;
  /** 正文里的图片地址 → 可以显示的 URL；关了"加载远程图片"时网络图片返回空串 */
  resolveImage(src: string, docPath: string | null): string;
  /** 本地文件的绝对路径 → 可以在页面里加载的 URL */
  fileUrl(path: string): string;

  // ---------- 图片、导出、主题 ----------
  /** 选一个要打开的文件（filters 例如 CSS） */
  pickFile(filter: FileFilter): Promise<string | null>;
  /** 选导出的保存位置 */
  pickExport(defaultPath: string, filter: FileFilter): Promise<string | null>;
  /** 系统剪贴板里的图片（PNG base64）；没有图片时 null */
  clipboardImage(): Promise<string | null>;
  /** 保存图片（base64），重名时自动加序号；返回实际路径 */
  imageWrite(path: string, base64: string): Promise<string>;
  imageCopy(from: string, to: string): Promise<string>;
  imageUpload(prefs: ImagePrefs, path: string): Promise<string>;
  readBase64(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  exportDocx(path: string, doc: unknown): Promise<void>;
  printWindow(): Promise<void>;
  themeList(): Promise<ThemeFile[]>;
  themeImport(path: string): Promise<ThemeFile>;
  themeRemove(name: string): Promise<void>;
  themeRead(path: string): Promise<string>;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** 导入的 Typora 主题：名字和 .css 的路径 */
export interface ThemeFile {
  name: string;
  path: string;
}

const MD_FILTER = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'txt'] }];

function toFileError(e: unknown): FileError {
  if (e instanceof FileError) return e;
  if (e && typeof e === 'object' && 'kind' in e) {
    const p = e as { kind: FileErrorKind; message?: string; current?: Stamp };
    return new FileError(p.kind, p.message ?? p.kind, p.current);
  }
  return new FileError('io', String(e));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toFileError(e);
  }
}

/**
 * 网络图片按设置决定加不加载。设置从 store 读（store 只引用这里的类型，不会循环依赖）；
 * 其他协议的地址（data:、blob:、asset: 等）原样返回。
 */
function remoteImage(src: string): string {
  return allowImage(src, useApp.getState().image);
}

const tauriBackend: Backend = {
  async pickOpen() {
    const p = await open({ multiple: false, directory: false, filters: MD_FILTER });
    return typeof p === 'string' ? p : null;
  },
  pickSave: (defaultPath) => save({ defaultPath, filters: MD_FILTER }),
  async pickFolder() {
    const p = await open({ multiple: false, directory: true });
    return typeof p === 'string' ? p : null;
  },
  listMarkdown: (root) => call('list_markdown', { root }),
  openFile: (path) => call('open_file', { path }),
  saveFile: (path, text, expected) => call('save_file', { path, text, expected }),
  loadSession: () => call('session_load'),
  async saveSession(session) {
    await call('session_save', { session: { ...session, updatedMs: 0 } });
  },
  launchPath: () => call('launch_path'),
  async askUnsaved(name) {
    const r = await message(t.unsavedMessage(name), {
      title: 'Zyrite',
      kind: 'warning',
      buttons: { yes: t.save, no: t.dontSave, cancel: t.cancel },
    });
    return r === t.save || r === 'Yes' ? 'save' : r === t.dontSave || r === 'No' ? 'discard' : 'cancel';
  },
  async askConflict(name) {
    const r = await message(t.conflictMessage(name), {
      title: 'Zyrite',
      kind: 'warning',
      buttons: { yes: t.overwrite, no: t.reload, cancel: t.cancel },
    });
    return r === t.overwrite || r === 'Yes' ? 'overwrite' : r === t.reload || r === 'No' ? 'reload' : 'cancel';
  },
  async showError(text) {
    await message(text, { title: 'Zyrite', kind: 'error' });
  },
  openExternal: (url) => openUrl(url),
  allowAssetDirs: (paths) => call('allow_asset_dirs', { paths }),
  listTree: (root, allFiles) => call('list_tree', { root, allFiles }),
  isDir: (path) => call('is_dir', { path }),
  createFile: (path) => call('create_file', { path }),
  createDir: (path) => call('create_dir', { path }),
  renamePath: (from, to, updateLinks) => call('rename_path', { from, to, updateLinks }),
  countLinkUpdates: (from, to) => call('count_link_updates', { from, to }),
  async askUpdateLinks(name, count) {
    const r = await message(t.updateLinksMessage(name, count), {
      title: 'Zyrite',
      kind: 'info',
      buttons: { yes: t.updateLinks, no: t.dontUpdateLinks, cancel: t.cancel },
    });
    return r === t.updateLinks || r === 'Yes' ? 'update' : r === t.dontUpdateLinks || r === 'No' ? 'skip' : 'cancel';
  },
  trashPath: (path) => call('trash_path', { path }),
  watch: (specs) => call('watch', { specs }),
  onFsChanged: (fn) => listen<FsChange[]>('zyrite://fs-changed', (e) => fn(e.payload)),
  askTrash: (name) => ask(t.trashMessage(name), { title: 'Zyrite', kind: 'warning', okLabel: t.moveToTrash, cancelLabel: t.cancel }),
  revealInDir: (path) => revealItemInDir(path),
  indexOpen: (root) => call('index_open', { root }),
  noteNames: () => call('note_names'),
  backlinks: (path) => call('backlinks', { path }),
  search: (query, limit) => call('search', { query, limit }),
  tags: () => call('tags'),
  notesWithTag: (tag) => call('notes_with_tag', { tag }),
  onIndexChanged: (fn) => listen('zyrite://index-changed', () => fn()),
  reviewGet: (path) => call('review_get', { path }),
  baselineSet: (path, text) => call('baseline_set', { path, text }),
  queueSet: (path, content) => call('queue_set', { path, content }),
  queueList: () => call('queue_list'),
  annotationsGet: (path) => call('annotations_get', { path }),
  annotationsSave: (path, list) => call('annotations_save', { path, list }),
  agentsGet: () => call('agents_get'),
  activityGet: (limit) => call('activity_get', { limit }),
  vaultConfigGet: () => call('vault_config_get'),
  vaultConfigSet: (config) => call('vault_config_set', { config }),
  mcpCommand: () => call('mcp_command'),
  menuLocalize: (settings) => call('menu_localize', { settings }),
  setLocale: (locale) => call('set_locale', { locale }),
  onOpenSettings: (fn) => listen('zyrite://open-settings', () => fn()),
  onOpenPath: (fn) => listen<string>('zyrite://open-path', (e) => fn(e.payload)),
  mcpAccessList: () => call('mcp_access_list'),
  mcpAccessAnswer: (id, allow) => call('mcp_access_answer', { id, allow }),
  mcpGrantSet: (id, write, directWrite) => call('mcp_grant_set', { id, write, directWrite }),
  mcpGrantRevoke: (id) => call('mcp_grant_revoke', { id }),
  onDataChanged: (fn) => listen<DataKind[]>('zyrite://data-changed', (e) => fn(e.payload)),
  aiKeySet: (id, key) => call('ai_key_set', { id, key }),
  aiKeyHas: (id) => call('ai_key_has', { id }),
  aiKeyDelete: (id) => call('ai_key_delete', { id }),
  aiChat: (id, provider, keyId, messages) => call('ai_chat', { id, provider, keyId, messages }),
  aiCancel: (id) => call('ai_cancel', { id }),
  onAiEvent: (fn) => listen<AiEvent>('zyrite://ai', (e) => fn(e.payload)),
  aiIndex: (provider) => call('ai_index', { provider, keyId: provider.id }),
  onAiIndex: (fn) => listen<{ done: number; total: number }>('zyrite://ai-index', (e) => fn(e.payload)),
  aiRetrieve: (question, scope, k, embed) => call('ai_retrieve', { question, scope, k, embed, keyId: embed?.id ?? null }),
  resolveImage(src, docPath) {
    if (!src) return src;
    if (isUrl(src)) return remoteImage(src);
    const abs = docPath ? resolvePath(dirname(docPath), decodeURI(src)) : src;
    return convertFileSrc(abs);
  },
  fileUrl: (path) => convertFileSrc(path),
  async pickFile(filter) {
    const p = await open({ multiple: false, directory: false, filters: [filter] });
    return typeof p === 'string' ? p : null;
  },
  pickExport: (defaultPath, filter) => save({ defaultPath, filters: [filter] }),
  clipboardImage: () => call('clipboard_image'),
  imageWrite: (path, base64) => call('image_write', { path, data: base64 }),
  imageCopy: (from, to) => call('image_copy', { from, to }),
  imageUpload: (prefs, path) =>
    call('image_upload', { mode: prefs.upload, picgoUrl: prefs.picgoUrl, command: prefs.command, path }),
  readBase64: (path) => call('read_base64', { path }),
  writeText: (path, text) => call('write_text', { path, text }),
  exportDocx: (path, doc) => call('export_docx', { path, doc }),
  printWindow: () => call('print_window'),
  themeList: () => call('theme_list'),
  themeImport: (path) => call('theme_import', { path }),
  themeRemove: (name) => call('theme_remove', { name }),
  themeRead: (path) => call('theme_read', { path }),
};

// ---------- 浏览器调试用 ----------

const WEB_FS = 'zyrite.webfs';
const WEB_SESSION = 'zyrite.session';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储不可用时只是没有恢复缓存
  }
}

type WebFs = Record<string, { text: string; stamp: Stamp }>;

/** 浏览器里没有文件系统：文件存在 localStorage，路径用对话框输入 */
export const webBackend: Backend = {
  async pickOpen() {
    const names = Object.keys(readJson<WebFs>(WEB_FS, {}));
    return window.prompt(`${t.openFile}\n${names.join('\n')}`, names[0] ?? '') || null;
  },
  async pickSave(defaultPath) {
    return window.prompt(t.saveAs, defaultPath) || null;
  },
  async pickFolder() {
    return window.prompt(t.openFolder, '/') || null;
  },
  async listMarkdown(root) {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return Object.keys(readJson<WebFs>(WEB_FS, {}))
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))
      .sort();
  },
  async openFile(path) {
    const f = readJson<WebFs>(WEB_FS, {})[path];
    if (!f) throw new FileError('notFound', path);
    return { path, ...f };
  },
  async saveFile(path, text, expected) {
    const fs = readJson<WebFs>(WEB_FS, {});
    const cur = fs[path];
    if (expected && cur && (cur.stamp.modifiedMs !== expected.modifiedMs || cur.stamp.len !== expected.len)) {
      throw new FileError('conflict', path, cur.stamp);
    }
    const stamp = { modifiedMs: Date.now(), len: new TextEncoder().encode(text).length };
    fs[path] = { text, stamp };
    writeJson(WEB_FS, fs);
    return stamp;
  },
  async loadSession() {
    return readJson<Session | null>(WEB_SESSION, null);
  },
  async saveSession(session) {
    writeJson(WEB_SESSION, { ...session, updatedMs: Date.now() });
  },
  async launchPath() {
    return null;
  },
  async askUnsaved(name) {
    if (window.confirm(`${t.unsavedMessage(name)}\n\n${t.save}?`)) return 'save';
    return window.confirm(`${t.dontSave}?`) ? 'discard' : 'cancel';
  },
  async askConflict(name) {
    if (window.confirm(`${t.conflictMessage(name)}\n\n${t.overwrite}?`)) return 'overwrite';
    return window.confirm(`${t.reload}?`) ? 'reload' : 'cancel';
  },
  async showError(text) {
    window.alert(text);
  },
  async openExternal(url) {
    window.open(url, '_blank', 'noopener');
  },
  async allowAssetDirs() {},
  async isDir(path) {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    return Object.keys(readJson<WebFs>(WEB_FS, {})).some((p) => p.startsWith(prefix));
  },
  async listTree(root) {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    const out = new Map<string, boolean>();
    for (const p of Object.keys(readJson<WebFs>(WEB_FS, {}))) {
      if (!p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) out.set(parts.slice(0, i).join('/'), true);
      if (!parts[parts.length - 1]?.startsWith('.')) out.set(rel, false);
      else out.set(parts.slice(0, -1).join('/'), true); // 空文件夹的占位文件
    }
    out.delete('');
    return [...out].map(([path, dir]) => ({ path, dir })).sort((a, b) => a.path.localeCompare(b.path));
  },
  async createFile(path) {
    const fs = readJson<WebFs>(WEB_FS, {});
    if (fs[path]) throw new FileError('exists', path);
    fs[path] = { text: '', stamp: { modifiedMs: Date.now(), len: 0 } };
    writeJson(WEB_FS, fs);
  },
  async createDir(path) {
    const fs = readJson<WebFs>(WEB_FS, {});
    fs[`${path}/.keep`] = { text: '', stamp: { modifiedMs: 0, len: 0 } };
    writeJson(WEB_FS, fs);
  },
  async countLinkUpdates() {
    return 0;
  },
  async askUpdateLinks() {
    return 'skip';
  },
  async renamePath(from, to) {
    const fs = readJson<WebFs>(WEB_FS, {});
    if (fs[to] || Object.keys(fs).some((p) => p.startsWith(`${to}/`))) throw new FileError('exists', to);
    const out: WebFs = {};
    for (const [p, f] of Object.entries(fs)) {
      if (p === from) out[to] = f;
      else if (p.startsWith(`${from}/`)) out[to + p.slice(from.length)] = f;
      else out[p] = f;
    }
    writeJson(WEB_FS, out);
    return [];
  },
  async trashPath(path) {
    const fs = readJson<WebFs>(WEB_FS, {});
    for (const p of Object.keys(fs)) if (p === path || p.startsWith(`${path}/`)) delete fs[p];
    writeJson(WEB_FS, fs);
  },
  async watch() {},
  async onFsChanged() {
    return () => {};
  },
  async askTrash(name) {
    return window.confirm(t.trashMessage(name));
  },
  async revealInDir() {},
  async indexOpen(root) {
    webIndexRoot = root;
  },
  async noteNames() {
    return webNotes().map(({ rel }) => ({ rel, stem: stemOf(rel), title: null, aliases: [] }));
  },
  async backlinks(path) {
    const notes = webNotes();
    const target = notes.find((n) => n.abs === path);
    if (!target) return { linked: [], unlinked: [] };
    const stem = stemOf(target.rel).toLowerCase();
    const linked: Mention[] = [];
    const unlinked: Mention[] = [];
    for (const n of notes) {
      if (n === target) continue;
      const lines = n.text.split('\n');
      const li = lines.findIndex((l) =>
        [...l.matchAll(/\[\[([^\]|#]+)/g)].some((m) => (m[1] ?? '').trim().toLowerCase() === stem),
      );
      if (li >= 0) linked.push({ from: n.rel, line: li, context: lines[li]!.trim() });
      else {
        const ui = lines.findIndex((l) => l.toLowerCase().includes(stem));
        if (ui >= 0) unlinked.push({ from: n.rel, line: ui, context: lines[ui]!.trim() });
      }
    }
    return { linked, unlinked };
  },
  async search(query, limit) {
    // 简化版：只支持空格分隔的词（都要出现）
    const started = performance.now();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return { hits: [], totalNotes: 0, totalMatches: 0, elapsedMs: 0 };
    const hits: SearchHit[] = [];
    let totalMatches = 0;
    for (const n of webNotes()) {
      const lower = n.text.toLowerCase();
      if (!terms.every((w) => lower.includes(w))) continue;
      const lines = n.text.split('\n');
      const matches: SearchMatch[] = [];
      let count = 0;
      lines.forEach((l, i) => {
        const at = l.toLowerCase().indexOf(terms[0]!);
        if (at < 0) return;
        count += l.toLowerCase().split(terms[0]!).length - 1;
        if (matches.length < 3) {
          matches.push({ line: i, before: l.slice(Math.max(0, at - 30), at), text: l.slice(at, at + terms[0]!.length), after: l.slice(at + terms[0]!.length, at + terms[0]!.length + 60) });
        }
      });
      totalMatches += count;
      hits.push({ rel: n.rel, title: null, count, matches });
    }
    return { hits: hits.slice(0, limit), totalNotes: hits.length, totalMatches, elapsedMs: Math.round(performance.now() - started) };
  },
  async tags() {
    const counts = new Map<string, number>();
    for (const n of webNotes()) {
      for (const tag of new Set(webTags(n.text))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([tag, count]) => ({ tag, count }));
  },
  async notesWithTag(tag) {
    const t = tag.replace(/^#/, '').toLowerCase();
    return webNotes()
      .filter((n) => webTags(n.text).some((x) => x.toLowerCase() === t || x.toLowerCase().startsWith(`${t}/`)))
      .map((n) => n.rel);
  },
  async onIndexChanged() {
    return () => {};
  },
  async reviewGet(path) {
    return { baseline: webData().baselines[path] ?? null, queued: webData().queue[path] ?? null };
  },
  async baselineSet(path, text) {
    updateWebData((d) => {
      if (text === null) delete d.baselines[path];
      else d.baselines[path] = text;
    });
  },
  async queueSet(path, content) {
    updateWebData((d) => {
      const item = d.queue[path];
      if (content === null || !item) delete d.queue[path];
      else d.queue[path] = { ...item, content };
    });
  },
  async queueList() {
    return Object.values(webData().queue);
  },
  async annotationsGet(path) {
    return webData().annotations[path] ?? [];
  },
  async annotationsSave(path, list) {
    updateWebData((d) => {
      d.annotations[path] = list;
    });
  },
  async agentsGet() {
    return [];
  },
  async activityGet() {
    return [];
  },
  async vaultConfigGet() {
    return webData().config;
  },
  async vaultConfigSet(config) {
    updateWebData((d) => {
      d.config = config;
    });
  },
  async mcpCommand() {
    return 'zyrite';
  },
  async menuLocalize() {},
  async setLocale() {},
  async onOpenSettings() {
    return () => {};
  },
  async onOpenPath() {
    return () => {};
  },
  // 网页版没有 MCP
  async mcpAccessList() {
    return { grants: [], requests: [] };
  },
  async mcpAccessAnswer() {},
  async mcpGrantSet() {},
  async mcpGrantRevoke() {},
  async onDataChanged() {
    return () => {};
  },
  async aiKeySet(id, key) {
    updateWebData((d) => {
      d.keys[id] = key;
    });
  },
  async aiKeyHas(id) {
    return !!webData().keys[id];
  },
  async aiKeyDelete(id) {
    updateWebData((d) => {
      delete d.keys[id];
    });
  },
  async aiChat(id, provider, keyId, messages) {
    // 浏览器调试：直接 fetch（服务商要允许跨域，本地测试用）
    const controller = new AbortController();
    webAi.set(id, controller);
    const emit = (e: AiEvent) => webAiListeners.forEach((fn) => fn(e));
    const key = webData().keys[keyId];
    const openai = provider.kind === 'openai';
    void (async () => {
      let full = '';
      try {
        const resp = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/${openai ? 'chat/completions' : 'api/chat'}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model: provider.model, messages, stream: true }),
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) throw new Error(`${resp.status} ${await resp.text()}`);
        const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            const data = openai ? (line.startsWith('data:') ? line.slice(5).trim() : '') : line;
            if (!data || data === '[DONE]') continue;
            const v = JSON.parse(data);
            const delta: string = openai ? (v.choices?.[0]?.delta?.content ?? '') : (v.message?.content ?? '');
            if (delta) {
              full += delta;
              emit({ id, delta, done: false });
            }
          }
        }
        emit({ id, text: full, done: true });
      } catch (e) {
        if (!controller.signal.aborted) emit({ id, error: String(e instanceof Error ? e.message : e), done: true });
      } finally {
        webAi.delete(id);
      }
    })();
  },
  async aiCancel(id) {
    webAi.get(id)?.abort();
  },
  async onAiEvent(fn) {
    webAiListeners.add(fn);
    return () => webAiListeners.delete(fn);
  },
  async aiIndex() {
    return { chunks: 0, embedded: 0 };
  },
  async onAiIndex() {
    return () => {};
  },
  async aiRetrieve(question, scope, k) {
    // 简化版：按词在笔记里找
    const words = question.toLowerCase().split(/[\s，。？！、,.?!]+/).filter((w) => w.length >= 2);
    return webNotes()
      .filter((n) => !scope || n.rel === scope || n.rel.startsWith(scope))
      .map((n) => ({ n, score: words.filter((w) => n.text.toLowerCase().includes(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ n, score }) => ({ rel: n.rel, line: 0, heading: '', text: n.text.slice(0, 800), score }));
  },
  resolveImage: (src, docPath) => {
    if (!src) return src;
    if (isUrl(src)) return remoteImage(src);
    const abs = docPath ? resolvePath(dirname(docPath), decodeURI(src)) : src;
    return readJson<Record<string, string>>(WEB_IMAGES, {})[abs] ?? src;
  },
  fileUrl: (path) => readJson<Record<string, string>>(WEB_IMAGES, {})[path] ?? path,
  async pickFile(filter) {
    return window.prompt(filter.name, '') || null;
  },
  async pickExport(defaultPath) {
    return window.prompt(t.saveAs, defaultPath) || null;
  },
  async clipboardImage() {
    return null;
  },
  async imageWrite(path, base64) {
    const images = readJson<Record<string, string>>(WEB_IMAGES, {});
    let target = path;
    for (let i = 1; images[target]; i++) target = path.replace(/(\.[^./]+)?$/, `-${i}$1`);
    const ext = (/\.([^./]+)$/.exec(target)?.[1] ?? 'png').toLowerCase();
    images[target] = `data:${ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`};base64,${base64}`;
    writeJson(WEB_IMAGES, images);
    return target;
  },
  async imageCopy(from, to) {
    return to === from ? to : this.imageWrite(to, await this.readBase64(from));
  },
  async imageUpload(prefs, path) {
    if (prefs.upload !== 'picgo') throw new Error(t.uploadPicgoOnly);
    const r = (await (await fetch(prefs.picgoUrl, { method: 'POST', body: JSON.stringify({ list: [path] }) })).json()) as {
      success: boolean;
      result?: string[];
    };
    if (!r.success || !r.result?.[0]) throw new Error(t.uploadFailed);
    return r.result[0];
  },
  async readBase64(path) {
    const url = readJson<Record<string, string>>(WEB_IMAGES, {})[path];
    if (url) return url.slice(url.indexOf(',') + 1);
    const blob = await (await fetch(path)).blob();
    const data = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(blob);
    });
    return data.slice(data.indexOf(',') + 1);
  },
  async writeText(path, text) {
    webDownload(path, new Blob([text], { type: 'text/html' }));
  },
  async exportDocx(path, doc) {
    // 浏览器里没有 Rust：把文档结构存下来，方便调试
    webDownload(`${path}.json`, new Blob([JSON.stringify(doc)], { type: 'application/json' }));
  },
  async printWindow() {
    window.print();
  },
  async themeList() {
    return Object.keys(readJson<Record<string, string>>(WEB_THEMES, {})).map((path) => ({
      name: path.slice(path.lastIndexOf('/') + 1).replace(/\.css$/i, ''),
      path,
    }));
  },
  async themeImport(path) {
    const css = await (await fetch(path)).text();
    writeJson(WEB_THEMES, { ...readJson<Record<string, string>>(WEB_THEMES, {}), [path]: css });
    return { name: path.slice(path.lastIndexOf('/') + 1).replace(/\.css$/i, ''), path };
  },
  async themeRemove(name) {
    const themes = readJson<Record<string, string>>(WEB_THEMES, {});
    for (const p of Object.keys(themes)) if (p.endsWith(`/${name}.css`)) delete themes[p];
    writeJson(WEB_THEMES, themes);
  },
  async themeRead(path) {
    return readJson<Record<string, string>>(WEB_THEMES, {})[path] ?? (await (await fetch(path)).text());
  },
};

const WEB_IMAGES = 'zyrite.webimages';
const WEB_THEMES = 'zyrite.webthemes';

function webDownload(path: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = path.slice(path.lastIndexOf('/') + 1);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const webAi = new Map<string, AbortController>();
const webAiListeners = new Set<(e: AiEvent) => void>();

// 浏览器调试用：.zyrite 里的数据放在 localStorage（键是文件的绝对路径）
const WEB_DATA = 'zyrite.webdata';
interface WebData {
  keys: Record<string, string>;
  baselines: Record<string, string>;
  queue: Record<string, QueueItem>;
  annotations: Record<string, Annotation[]>;
  config: VaultConfig;
}

function webData(): WebData {
  return {
    keys: {},
    baselines: {},
    queue: {},
    annotations: {},
    config: { review: { enabled: true }, mcp: { read: true, write: true, directWrite: false } },
    ...readJson<Partial<WebData>>(WEB_DATA, {}),
  };
}

function updateWebData(fn: (d: WebData) => void) {
  const d = webData();
  fn(d);
  writeJson(WEB_DATA, d);
}

// 浏览器调试用的简化索引（Tauri 里由 crates/zyrite-core 的 index 模块负责）
let webIndexRoot: string | null = null;

function stemOf(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
}

function webNotes() {
  if (!webIndexRoot) return [];
  const prefix = `${webIndexRoot}/`;
  return Object.entries(readJson<WebFs>(WEB_FS, {}))
    .filter(([p]) => p.startsWith(prefix) && /\.md$/i.test(p))
    .map(([abs, f]) => ({ abs, rel: abs.slice(prefix.length), text: f.text }));
}

function webTags(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s(（，。；：、])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)].map((m) => m[1] ?? '');
}

export const backend: Backend = isTauri ? tauriBackend : webBackend;
