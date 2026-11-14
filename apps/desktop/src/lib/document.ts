import { t } from '../i18n';
import { useApp } from '../store';
import { backend, type Backend, FileError, type LoadedFile, type Stamp, UTF8 } from './backend';
import { activeEditor } from './editorRef';
import {
  basename,
  dirname,
  IMAGE_EXT,
  isDocument,
  isMarkdownDoc,
  isSensitive,
  isUrl,
  linkForFile,
  linkPath,
  LOG_FILE,
  MARKDOWN_EXT,
  resolvePath,
} from './paths';

/**
 * 文档的打开、保存、新建和恢复缓存。
 * - 保存带上打开时的文件戳：期间文件被 Agent 等外部程序改过，就问用户覆盖还是重新载入，不会悄悄覆盖
 * - 编辑中每 2 秒把未保存的内容写进恢复缓存，下次启动时还原
 */

/** 测试时替换 */
export const deps: { backend: Backend } = { backend };

/** 恢复缓存的写入间隔 */
export const RECOVERY_INTERVAL = 2000;

/** 超过这个大小的文本文件只读打开（编辑器能处理，但逐字输入会卡、恢复缓存也太大） */
export const READ_ONLY_BYTES = 5 * 1024 * 1024;

/** 编辑次数，恢复缓存据此判断要不要写 */
let edits = 0;
let persistedEdits = 0;
/** 正在保存的文件：保存期间收到的它的变化事件是自己写的，不处理 */
let saving: string | null = null;

/** 当前文档的全文：编辑器建好了就从编辑器取（最新），否则用 store 里的 */
function currentText(): string {
  const { text, docId } = useApp.getState();
  const editor = activeEditor.current;
  return editor && activeEditor.docId === docId ? editor.getText() : text;
}

function displayName(path: string | null): string {
  return path ? basename(path) : t.untitled;
}

function notify(text: string, error = false) {
  useApp.getState().setNotice({ text, error });
}

function errorText(e: unknown, path: string): string {
  const err = e instanceof FileError ? e : new FileError('io', String(e));
  const name = basename(path);
  if (err.kind === 'notFound') return t.errNotFound(name);
  if (err.kind === 'notUtf8') return t.errNotUtf8(name);
  if (err.kind === 'binary') return t.errBinary(name);
  if (err.kind === 'decode') return t.errDecode(name);
  return t.errIo(name, err.message);
}

/** 编辑器内容变化时调用 */
export function noteEdit() {
  edits++;
  useApp.getState().markEdited();
}

/** 把当前状态写进恢复缓存：有未保存的修改就带上全文 */
export async function persistSession(): Promise<void> {
  const s = useApp.getState();
  const text = currentText();
  persistedEdits = edits;
  try {
    await deps.backend.saveSession({
      path: s.filePath,
      text: text !== s.savedText ? text : null,
      stamp: s.stamp,
      folder: s.folder,
    });
  } catch {
    // 恢复缓存写失败不打扰用户，下次再试
  }
}

/** 定时写恢复缓存，返回停止函数 */
export function startRecovery(interval = RECOVERY_INTERVAL): () => void {
  const timer = setInterval(() => {
    if (edits !== persistedEdits) void persistSession();
  }, interval);
  return () => clearInterval(timer);
}

/** 有未保存的修改时问用户；返回 false 表示用户取消，调用方应停止当前操作 */
export async function ensureSaved(): Promise<boolean> {
  const s = useApp.getState();
  // 新文档的 savedText 是空串，什么都没写也不用问
  if (currentText() === s.savedText) return true;
  const choice = await deps.backend.askUnsaved(displayName(s.filePath));
  if (choice === 'save') return save();
  return choice === 'discard';
}

interface OpenOptions {
  /** 不检查未保存的修改（调用方已经处理过） */
  force?: boolean;
  /** 出错时只在状态栏提示，不弹窗（点击链接时） */
  quiet?: boolean;
}

/**
 * 文本文件打开时的只读判断和提示：日志只读（内容追加时跟到末尾），过大的文件只读，可能含密钥的文件提醒一下。
 * Markdown 不受影响。
 */
function textFileNotice(path: string, len: number): { readOnly: boolean; notice: string | null } {
  if (isMarkdownDoc(path)) return { readOnly: false, notice: null };
  if (len > READ_ONLY_BYTES) return { readOnly: true, notice: t.largeReadOnly((len / 1024 / 1024).toFixed(1)) };
  if (LOG_FILE.test(path)) return { readOnly: true, notice: t.logReadOnly };
  return { readOnly: false, notice: isSensitive(path) ? t.sensitiveFile : null };
}

export async function openPath(path: string, opts: OpenOptions = {}): Promise<boolean> {
  if (!opts.force && !(await ensureSaved())) return false;
  try {
    showLoaded(await deps.backend.openFile(path));
  } catch (e) {
    // 二进制文件（在文件树里点了图片、程序等）只在状态栏提示，不弹窗
    if (opts.quiet || (e instanceof FileError && e.kind === 'binary')) notify(errorText(e, path), true);
    else await deps.backend.showError(errorText(e, path));
    return false;
  }
  edits = persistedEdits = 0;
  await persistSession();
  return true;
}

/** 把读到的文件放进编辑器：只读判断、编码、提示 */
function showLoaded(f: LoadedFile) {
  const { readOnly, notice } = textFileNotice(f.path, f.stamp.len);
  const encoding = f.encoding ?? UTF8;
  useApp
    .getState()
    .loadDoc({ filePath: f.path, text: f.text, savedText: f.text, stamp: f.stamp, dirty: false, readOnly, encoding });
  useApp.getState().addRecent(f.path);
  // 不是 UTF-8 的文件提示一下：保存时按原编码写回
  const text = notice ?? (encoding !== UTF8 ? t.encodingDetected(encoding) : null);
  if (text) useApp.getState().setNotice({ text, durationMs: 6000 });
}

/** 按指定的编码重新打开当前文件（状态栏的编码菜单）；有未保存的修改先问 */
export async function reopenWithEncoding(encoding: string): Promise<boolean> {
  const { filePath } = useApp.getState();
  if (!filePath || !(await ensureSaved())) return false;
  try {
    showLoaded(await deps.backend.openFileAs(filePath, encoding));
  } catch (e) {
    notify(errorText(e, filePath), true);
    return false;
  }
  edits = persistedEdits = 0;
  await persistSession();
  return true;
}

/** 当前文件改存成 UTF-8：立即保存一次 */
export async function convertToUtf8(): Promise<boolean> {
  const { filePath } = useApp.getState();
  if (!filePath) return false;
  useApp.setState({ encoding: UTF8 });
  return save();
}

export async function openDialog(): Promise<boolean> {
  if (!(await ensureSaved())) return false;
  const path = await deps.backend.pickOpen();
  return path ? openPath(path, { force: true }) : false;
}

export async function newDoc(): Promise<boolean> {
  if (!(await ensureSaved())) return false;
  useApp.getState().loadDoc({ filePath: null, text: '', savedText: '', stamp: null, dirty: false });
  edits = persistedEdits = 0;
  await persistSession();
  return true;
}

async function writeTo(path: string, expected: Stamp | null): Promise<boolean> {
  const text = currentText();
  saving = path;
  const encoding = useApp.getState().encoding ?? UTF8;
  try {
    const stamp = await deps.backend.saveFile(path, text, expected, encoding);
    // 用户自己保存的内容就是新的审阅基线
    await deps.backend.baselineSet(path, text).catch(() => {});
    // 保存是异步的，期间可能又输入了内容
    const now = currentText();
    useApp.getState().markSaved(path, text, stamp, now !== text);
    useApp.getState().addRecent(path);
    useApp.getState().setText(now);
    notify(t.saved);
    await persistSession();
    return true;
  } catch (e) {
    // 有字符不能用原编码保存（比如在 GBK 文件里输入了表情）：问要不要改存成 UTF-8，什么都没写入
    if (e instanceof FileError && e.kind === 'unmappable') {
      saving = null;
      if (!(await deps.backend.askUnmappable(basename(path), encoding))) return false;
      useApp.setState({ encoding: UTF8 });
      return writeTo(path, expected);
    }
    if (e instanceof FileError && e.kind === 'conflict') {
      const choice = await deps.backend.askConflict(basename(path));
      if (choice === 'overwrite') return writeTo(path, null);
      if (choice === 'reload') await openPath(path, { force: true });
      return false;
    }
    await deps.backend.showError(errorText(e, path));
    return false;
  } finally {
    saving = null;
  }
}

export async function save(): Promise<boolean> {
  const { filePath, stamp } = useApp.getState();
  if (!filePath) return saveAs();
  return writeTo(filePath, stamp);
}

export async function saveAs(): Promise<boolean> {
  const { filePath } = useApp.getState();
  const path = await deps.backend.pickSave(filePath ?? t.untitled);
  if (!path) return false;
  // 另存为同一个文件时照常检查外部修改
  return writeTo(path, path === filePath ? useApp.getState().stamp : null);
}

/** 打开文件夹：之后 ⌘P 在这个文件夹里找文件（文件树、监听等随 M2 的库一起做） */
export async function openFolder(): Promise<boolean> {
  const folder = await deps.backend.pickFolder();
  if (!folder) return false;
  await openFolderPath(folder);
  return true;
}

/** 把一个文件夹当作库打开（选择文件夹、拖入文件夹） */
export async function openFolderPath(folder: string, opts: { quickOpen?: boolean } = {}): Promise<void> {
  useApp.getState().setFolder(folder);
  void deps.backend.allowAssetDirs([folder]).catch(() => {});
  await persistSession();
  if (opts.quickOpen !== false) useApp.getState().setQuickOpen(true);
}

/** ⌘P 的搜索范围：打开的文件夹，没有就是当前文件所在目录 */
export function quickOpenRoot(): string | null {
  const { folder, filePath } = useApp.getState();
  return folder ?? (filePath ? dirname(filePath) || null : null);
}

/**
 * 当前文件在外部被修改或删除（文件监听报告）。简洁版只提示"已被外部修改并刷新"；
 * 完整版的逐处审阅随 M3 做。
 * - 内容和磁盘上一致（自己刚保存的、改名后的）：只更新文件戳
 * - 没有未保存的修改：重新载入，保留光标和滚动位置
 * - 有未保存的修改：不动内容，提示；保存时会走冲突处理
 */
export async function onExternalChange(path: string, kind: 'create' | 'modify' | 'remove'): Promise<void> {
  const s = useApp.getState();
  if (s.filePath !== path || saving === path) return;
  if (kind === 'remove') {
    notify(t.externalRemoved, true);
    return;
  }
  let f;
  try {
    f = await deps.backend.openFile(path);
  } catch {
    return; // 读的时候又被删了或正在写，下一个事件再处理
  }
  const now = useApp.getState();
  if (now.filePath !== path) return;
  const sameStamp = now.stamp && now.stamp.modifiedMs === f.stamp.modifiedMs && now.stamp.len === f.stamp.len;
  if (sameStamp) return;
  if (f.text === now.savedText) {
    useApp.setState({ stamp: f.stamp });
    return;
  }
  if (currentText() === now.savedText) {
    now.loadDoc(
      {
        filePath: path,
        text: f.text,
        savedText: f.text,
        stamp: f.stamp,
        dirty: false,
        readOnly: now.readOnly,
        encoding: f.encoding ?? UTF8,
      },
      { keepView: true },
    );
    // 日志一直在追加，不每次都提示
    if (!LOG_FILE.test(path)) notify(t.externalReloaded);
    await persistSession();
    return;
  }
  // 文本文件没有按块审阅：保存时走冲突处理（覆盖或重新载入）
  if (!isMarkdownDoc(path)) {
    notify(t.externalChangedText, true);
    return;
  }
  // 有未保存的修改：和 Agent 的版本三方合并（不冲突的自动合并，冲突的进"并排合并"）
  const { mergeExternal } = await import('./review');
  await mergeExternal(path, f.text, f.stamp);
}

/** 关闭窗口前：处理未保存的修改；用户选择不保存时清掉恢复缓存里的内容。返回 false 表示取消关闭 */
export async function prepareClose(): Promise<boolean> {
  if (!(await ensureSaved())) return false;
  const s = useApp.getState();
  try {
    await deps.backend.saveSession({ path: s.filePath, text: null, stamp: s.stamp, folder: s.folder });
  } catch {
    // 忽略
  }
  return true;
}

/** 启动时：还原未保存的修改，或重新打开上次的文件；再打开命令行传进来的文件 */
export async function restoreSession(): Promise<void> {
  const session = await deps.backend.loadSession().catch(() => null);
  // 上次打开的文件夹已经删掉或改名了：不再显示它（下次保存会话时自然从记录里去掉）
  if (session?.folder && (await deps.backend.isDir(session.folder).catch(() => false))) {
    useApp.getState().setFolder(session.folder);
    void deps.backend.allowAssetDirs([session.folder]).catch(() => {});
  }
  if (session?.text != null) {
    let savedText = '';
    let stamp = session.stamp;
    let encoding: string | undefined;
    if (session.path) {
      try {
        const f = await deps.backend.openFile(session.path);
        savedText = f.text;
        encoding = f.encoding;
        // 保留会话里的戳：还原后保存时，能发现这期间文件被外部改过
        stamp ??= f.stamp;
      } catch {
        // 文件已经不在了：内容还在，保存时会重新创建
      }
    }
    const dirty = session.text !== savedText;
    useApp.getState().loadDoc({ filePath: session.path, text: session.text, savedText, stamp, dirty, encoding });
    if (dirty) {
      edits = 1;
      persistedEdits = 1;
      // 重要信息，多留一会儿
      useApp.getState().setNotice({ text: t.restoredUnsaved, durationMs: 15000 });
    }
  } else if (session?.path) {
    await openPath(session.path, { force: true, quiet: true });
  }

  const launch = await deps.backend.launchPath().catch(() => null);
  if (launch && launch !== useApp.getState().filePath) await openPath(launch);
}

/**
 * 拖入文件：
 * - 有文件夹：当作库打开；有 Markdown 文件：打开第一个（和 Typora 一样，拖进来就是打开）
 * - 只有图片和其他文件：在落点插入链接，图片用 `![]()`，其他文件用 `[]()`，路径相对于当前文档
 * at 是窗口内的 CSS 像素坐标。
 */
export async function dropFiles(paths: string[], at?: { x: number; y: number }): Promise<void> {
  if (!paths.length) return;
  const dirs: string[] = [];
  for (const p of paths) {
    if (!MARKDOWN_EXT.test(p) && !IMAGE_EXT.test(p) && (await deps.backend.isDir(p).catch(() => false))) dirs.push(p);
  }
  const notes = paths.filter((p) => MARKDOWN_EXT.test(p));
  if (dirs.length || notes.length) {
    // 先打开文档：有未保存的修改时会先问，取消了就不换库
    if (notes.length && !(await openPath(notes[0]!))) return;
    if (dirs.length) await openFolderPath(dirs[0]!, { quickOpen: !notes.length });
    return;
  }
  const editor = activeEditor.current;
  if (!editor) return;
  const { filePath } = useApp.getState();
  await deps.backend.allowAssetDirs(paths).catch(() => {});
  // 图片按设置复制到 assets、上传图床（lib/images）；其他文件直接链接
  const { placeImagePath } = await import('./images');
  const parts: string[] = [];
  for (const p of paths) {
    if (!IMAGE_EXT.test(p)) parts.push(linkForFile(p, filePath));
    else parts.push(await placeImagePath(p).catch(() => linkForFile(p, filePath)));
  }
  editor.insertMarkdown(parts.join('\n'), at);
}

/** 点击正文里的链接（⌘/Ctrl + 点击） */
export async function openLink(href: string, kind: 'url' | 'wikilink'): Promise<void> {
  if (kind === 'url' && isUrl(href)) {
    await deps.backend.openExternal(href);
    return;
  }
  const { filePath } = useApp.getState();
  if (!filePath) return;
  let rel = kind === 'wikilink' ? (href.split('#')[0] ?? '').trim() : linkPath(href);
  if (!rel) return; // 只有锚点：文内跳转以后再做
  if (kind === 'wikilink' && !MARKDOWN_EXT.test(rel)) rel += '.md';
  const target = resolvePath(dirname(filePath), rel);
  if (isDocument(target)) await openPath(target, { quiet: true });
}
