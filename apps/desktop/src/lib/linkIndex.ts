import { t } from '../i18n';
import { useApp } from '../store';
import type { NoteName } from './backend';
import { deps, ensureSaved, openPath } from './document';
import { activeEditor, onEditorReady } from './editorRef';
import { fuzzyFilter } from './fuzzy';
import { createResolver, type Resolver } from './links';
import { basename, dirname, resolvePath } from './paths';
import { refreshTree, relInVault } from './vault';

/**
 * 双链和标签索引在前端的一侧：索引本身在 Rust 里（crates/zyrite-core/src/index.rs），
 * 这里拿笔记名单做同步解析（编辑器里不存在的链接显示成虚线），以及点击双链打开或创建笔记。
 */

let resolverFor: readonly NoteName[] | null = null;
let resolver: Resolver | null = null;

function getResolver(): Resolver | null {
  const { noteNames } = useApp.getState();
  if (!noteNames) return null;
  if (resolverFor !== noteNames) {
    resolverFor = noteNames;
    resolver = createResolver(noteNames);
  }
  return resolver;
}

/** 重新拉笔记名单，并让编辑器重新判断双链 */
export async function loadNoteNames(): Promise<void> {
  const { folder } = useApp.getState();
  if (!folder) {
    useApp.setState({ noteNames: null });
    return;
  }
  try {
    const names = await deps.backend.noteNames();
    if (useApp.getState().folder !== folder) return;
    useApp.setState({ noteNames: names, indexVersion: useApp.getState().indexVersion + 1 });
    activeEditor.current?.refreshLinks();
  } catch {
    // 索引还没建好；建好后会收到 index-changed 再来
  }
}

/** 打开库（或关闭）时建索引 */
export async function openIndex(): Promise<void> {
  const { folder } = useApp.getState();
  useApp.setState({ noteNames: null });
  try {
    await deps.backend.indexOpen(folder);
  } catch {
    return;
  }
  await loadNoteNames();
}

/** 当前文档里的双链目标是否存在；没打开库、或当前文件不在库里时无法判断，按存在处理 */
export function linkStatus(target: string): 'note' | 'missing' | 'other' {
  const r = getResolver();
  const { filePath } = useApp.getState();
  if (!r) return 'other';
  const from = filePath ? relInVault(filePath) : '';
  if (from === null) return 'other';
  return r.resolveWiki(target, from).kind;
}

/**
 * 点击双链：库里有就打开，没有就创建（点击即创建）。
 * 新笔记放在当前笔记所在的文件夹；目标里带路径（`[[docs/新笔记]]`）时相对库根目录。
 */
export async function openWikiLink(target: string): Promise<void> {
  const { folder, filePath } = useApp.getState();
  const r = getResolver();
  const name = (target.split('#')[0] ?? '').trim();
  if (!folder || !r || !name) return;
  const from = filePath ? (relInVault(filePath) ?? '') : '';
  const status = r.resolveWiki(name, from);
  if (status.kind === 'note') {
    await openPath(resolvePath(folder, status.rel), { quiet: true });
    return;
  }
  if (status.kind === 'other') return;
  if (!(await ensureSaved())) return;
  const base = name.includes('/') ? folder : filePath && relInVault(filePath) !== null ? dirname(filePath) : folder;
  const path = resolvePath(base, /\.md$/i.test(name) ? name : `${name}.md`);
  try {
    await deps.backend.createFile(path);
  } catch (e) {
    useApp.getState().setNotice({ text: t.errIo(basename(path), e instanceof Error ? e.message : String(e)), error: true });
    return;
  }
  await refreshTree();
  await openPath(path, { force: true });
  useApp.getState().setNotice({ text: t.createdNote(basename(path)) });
}

/** 打开文件并跳到第 line 行（反向链接、未链接提及） */
export async function openAt(path: string, line: number): Promise<void> {
  const reveal = () => {
    const text = activeEditor.current?.getText() ?? useApp.getState().text;
    let offset = 0;
    for (let i = 0; i < line; i++) {
      const next = text.indexOf('\n', offset);
      if (next < 0) break;
      offset = next + 1;
    }
    activeEditor.current?.revealOffset(offset);
  };
  if (useApp.getState().filePath === path) {
    reveal();
    return;
  }
  // 打开后编辑器会重建，等新编辑器好了再跳
  const off = onEditorReady(() => {
    off();
    reveal();
  });
  if (!(await openPath(path, { quiet: true }))) off();
}

interface Candidate {
  label: string;
  detail?: string;
  insert: string;
  rel: string;
}

/**
 * 输入 `[[` 后的补全：文件名和别名都能搜。
 * 重名的笔记插入路径（`docs/plan`），保证链接指向唯一；别名插入 `名字|别名`。
 * 还没输入文字时，最近打开的排在前面。
 */
export function completeLinks(query: string): { label: string; detail?: string; insert: string }[] {
  const { noteNames, recent, folder } = useApp.getState();
  if (!noteNames || !folder) return [];
  const stemCount = new Map<string, number>();
  for (const n of noteNames) stemCount.set(n.stem.toLowerCase(), (stemCount.get(n.stem.toLowerCase()) ?? 0) + 1);
  const candidates: Candidate[] = noteNames.flatMap((n) => {
    const dir = n.rel.includes('/') ? n.rel.slice(0, n.rel.lastIndexOf('/')) : '';
    const target = (stemCount.get(n.stem.toLowerCase()) ?? 0) > 1 ? n.rel.replace(/\.[^./]+$/, '') : n.stem;
    return [
      { label: n.stem, detail: dir || undefined, insert: target, rel: n.rel },
      ...n.aliases.map((a) => ({ label: a, detail: n.stem, insert: `${target}|${a}`, rel: n.rel })),
    ];
  });
  const strip = ({ label, detail, insert }: Candidate) => ({ label, detail, insert });
  if (!query.trim()) {
    const recentRel = recent.map((p) => relInVault(p)).filter((r): r is string => !!r);
    const rank = (c: Candidate) => {
      const i = recentRel.indexOf(c.rel);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return candidates
      .filter((c) => !c.insert.includes('|'))
      .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
      .slice(0, 20)
      .map(strip);
  }
  return fuzzyFilter(query, candidates, (c) => c.label, 20).map(({ item }) => strip(item));
}

/** 双链目标对应的笔记绝对路径（嵌入 `![[笔记]]` 用）；没打开库或找不到时返回 null */
export function notePath(target: string): string | null {
  const { folder, filePath } = useApp.getState();
  const r = getResolver();
  if (!folder || !r) return null;
  const from = filePath ? (relInVault(filePath) ?? '') : '';
  const status = r.resolveWiki(target, from);
  return status.kind === 'note' ? resolvePath(folder, status.rel) : null;
}
