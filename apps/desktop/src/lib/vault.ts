import { t } from '../i18n';
import { useApp } from '../store';
import { type FsChange, FileError, type WatchSpec } from './backend';
import { deps, ensureSaved, onExternalChange, openPath, persistSession } from './document';
import { basename, dirname, MARKDOWN_EXT, relativePath, resolvePath } from './paths';

/**
 * 库：文件树、文件操作、文件监听。
 * 文件操作完成后立即刷新文件树（不等监听事件），监听只用来发现外部的变化。
 */

function notifyError(text: string) {
  useApp.getState().setNotice({ text, error: true });
}

function errorText(e: unknown, path: string): string {
  if (e instanceof FileError && e.kind === 'exists') return t.errExists(basename(path));
  if (e instanceof FileError && e.kind === 'notFound') return t.errNotFound(basename(path));
  return t.errIo(basename(path), e instanceof Error ? e.message : String(e));
}

/** 路径分隔符沿用库根目录的写法 */
function join(dir: string, name: string): string {
  return resolvePath(dir, name);
}

/** 绝对路径 → 相对 folder（`/` 分隔）；不在 folder 里返回 null */
function relUnder(folder: string, path: string): string | null {
  const rel = relativePath(folder, path);
  return rel.startsWith('..') || rel === '.' || /^[a-z]:/i.test(rel) || rel.startsWith('/') ? null : rel;
}

/** 绝对路径 → 相对库根目录；不在库里（或没打开库）返回 null */
export function relInVault(path: string): string | null {
  const { folder } = useApp.getState();
  return folder ? relUnder(folder, path) : null;
}

// ---------- 文件树 ----------

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export async function refreshTree(): Promise<void> {
  const { folder } = useApp.getState();
  if (!folder) {
    useApp.getState().setTree(null);
    return;
  }
  try {
    const tree = await deps.backend.listTree(folder, false);
    if (useApp.getState().folder === folder) useApp.getState().setTree(tree);
  } catch (e) {
    notifyError(errorText(e, folder));
  }
}

/** 连续的变化合并成一次刷新 */
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshTree(), 80);
}

/** 展开当前文件所在的所有上级文件夹 */
export function revealInTree(path: string) {
  const rel = relInVault(path);
  if (!rel) return;
  const parts = rel.split('/');
  const { expanded, setExpanded } = useApp.getState();
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (!expanded[dir]) setExpanded(dir, true);
  }
}

// ---------- 文件监听 ----------

/** 监听范围：打开的文件夹（递归），加上库外单独打开的文件所在目录 */
export function watchSpecs(folder: string | null, filePath: string | null): WatchSpec[] {
  const specs: WatchSpec[] = [];
  if (folder) specs.push({ path: folder, recursive: true });
  if (filePath && (!folder || !relUnder(folder, filePath))) {
    const dir = dirname(filePath);
    if (dir) specs.push({ path: dir, recursive: false });
  }
  return specs;
}

let lastWatch = '';

export async function updateWatch(): Promise<void> {
  const { folder, filePath } = useApp.getState();
  const specs = watchSpecs(folder, filePath);
  const key = JSON.stringify(specs);
  if (key === lastWatch) return;
  lastWatch = key;
  try {
    await deps.backend.watch(specs);
  } catch {
    lastWatch = ''; // 下次再试
  }
}

/** 处理文件监听报告的变化 */
export function handleFsChanges(changes: FsChange[]) {
  const { folder, filePath } = useApp.getState();
  // 只有增删（或文件夹、忽略规则变化）才影响文件树；文件内容修改不用刷新
  if (folder && changes.some((c) => c.kind !== 'modify' || c.dir || c.path.endsWith('.zyriteignore'))) {
    scheduleRefresh();
  }
  const mine = filePath ? changes.find((c) => c.path === filePath) : undefined;
  if (mine) void onExternalChange(mine.path, mine.kind);
}

// ---------- 文件操作 ----------

const BAD_NAME = /[/\\:*?"<>|]/;

export function validName(name: string): boolean {
  const n = name.trim();
  return !!n && n !== '.' && n !== '..' && !BAD_NAME.test(n);
}

/** 同一目录下不重名：未命名.md、未命名 1.md、未命名 2.md…… */
function uniqueName(dir: string, base: string, ext: string): string {
  const taken = new Set(
    (useApp.getState().tree ?? [])
      .filter((e) => {
        const rel = relInVault(dir);
        const parent = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
        return parent === (rel ?? '');
      })
      .map((e) => e.path.slice(e.path.lastIndexOf('/') + 1).toLowerCase()),
  );
  for (let i = 0; ; i++) {
    const name = `${base}${i ? ` ${i}` : ''}${ext}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** 在文件夹里新建笔记并打开，接着进入改名 */
export async function newNote(dir: string): Promise<void> {
  if (!(await ensureSaved())) return;
  const path = join(dir, uniqueName(dir, t.untitledNote, '.md'));
  try {
    await deps.backend.createFile(path);
  } catch (e) {
    notifyError(errorText(e, path));
    return;
  }
  await refreshTree();
  await openPath(path, { force: true });
  revealInTree(path);
  useApp.getState().setRenaming(path);
}

export async function newFolder(dir: string): Promise<void> {
  const path = join(dir, uniqueName(dir, t.untitledFolder, ''));
  try {
    await deps.backend.createDir(path);
  } catch (e) {
    notifyError(errorText(e, path));
    return;
  }
  await refreshTree();
  revealInTree(path);
  useApp.getState().setRenaming(path);
}

/** 改名或移动后，同步当前文件路径、最近打开、展开状态 */
function afterMove(from: string, to: string) {
  const s = useApp.getState();
  const mapPath = (p: string) => (p === from ? to : p.startsWith(`${from}/`) || p.startsWith(`${from}\\`) ? to + p.slice(from.length) : p);
  if (s.filePath) {
    const moved = mapPath(s.filePath);
    if (moved !== s.filePath) {
      s.setFilePath(moved);
      void persistSession();
    }
  }
  useApp.setState({ recent: s.recent.map(mapPath) });
  const relFrom = relInVault(from);
  const relTo = relInVault(to);
  if (relFrom && relTo) {
    const expanded: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(s.expanded)) {
      expanded[k === relFrom ? relTo : k.startsWith(`${relFrom}/`) ? relTo + k.slice(relFrom.length) : k] = v;
    }
    useApp.setState({ expanded });
  }
}

/** 改名；文件原来是 .md 而新名字没写扩展名时自动补上 */
export async function renameEntry(path: string, newName: string): Promise<boolean> {
  useApp.getState().setRenaming(null);
  let name = newName.trim();
  if (name === basename(path)) return true;
  if (!validName(name)) {
    notifyError(t.errBadName);
    return false;
  }
  const isDir = (useApp.getState().tree ?? []).some((e) => e.dir && relInVault(path) === e.path);
  if (!isDir && MARKDOWN_EXT.test(basename(path)) && !/\.[^.]+$/.test(name)) name += '.md';
  return moveTo(path, join(dirname(path), name));
}

/** 拖到另一个文件夹 */
export async function moveEntry(path: string, destDir: string): Promise<boolean> {
  if (dirname(path) === destDir) return true;
  const ok = await moveTo(path, join(destDir, basename(path)));
  if (ok) useApp.getState().setNotice({ text: t.movedTo(basename(destDir) || destDir) });
  return ok;
}

/**
 * 改名或移动。有链接指向它（或它里面的笔记）时先问要不要一起更新；
 * 用户取消就不改名。
 */
async function moveTo(from: string, to: string): Promise<boolean> {
  let updateLinks = false;
  const count = await deps.backend.countLinkUpdates(from, to).catch(() => 0);
  if (count > 0) {
    const choice = await deps.backend.askUpdateLinks(basename(from), count);
    if (choice === 'cancel') return false;
    updateLinks = choice === 'update';
  }
  let updated: string[];
  try {
    updated = await deps.backend.renamePath(from, to, updateLinks);
  } catch (e) {
    notifyError(errorText(e, to));
    return false;
  }
  afterMove(from, to);
  await refreshTree();
  if (updated.length) useApp.getState().setNotice({ text: t.linksUpdated(updated.length) });
  return true;
}

/** 移到回收站（先确认）；删的是当前文件（或它所在的文件夹）时换成空白新文档 */
export async function trashEntry(path: string): Promise<boolean> {
  if (!(await deps.backend.askTrash(basename(path)))) return false;
  try {
    await deps.backend.trashPath(path);
  } catch (e) {
    notifyError(errorText(e, path));
    return false;
  }
  const { filePath } = useApp.getState();
  if (filePath && (filePath === path || filePath.startsWith(`${path}/`) || filePath.startsWith(`${path}\\`))) {
    useApp.getState().loadDoc({ filePath: null, text: '', savedText: '', stamp: null, dirty: false });
    await persistSession();
  }
  useApp.setState({ recent: useApp.getState().recent.filter((p) => p !== path && !p.startsWith(`${path}/`)) });
  await refreshTree();
  return true;
}
