import { acceptHunk, diffBlocks, type Hunk, type Merge, merge3, rejectHunk, resolveMerge } from '@zyrite/md-blocks';
import { t } from '../i18n';
import { useApp } from '../store';
import { type Stamp, FileError } from './backend';
import { deps, persistSession } from './document';
import { activeEditor } from './editorRef';
import { relInVault } from './vault';

/**
 * Agent 改动的审阅。
 *
 * 两种来源：
 * - disk：Agent 直接写了磁盘。比较"基线"（用户最后确认过的版本）和磁盘上的内容。
 *   接受一处 = 基线向磁盘前进一步；拒绝一处 = 把这一块从基线写回磁盘。
 * - queue：Agent 通过 MCP 的 write_note 写入，内容在审阅队列里，磁盘没动。
 *   接受一处 = 写进磁盘；拒绝一处 = 从队列的提议里撤掉。
 *
 * 用户有未保存的修改时外部写入：三方合并（基线 / 你的 / Agent 的），不冲突的自动合并，冲突的进"并排合并"。
 */

export interface ReviewState {
  /** 绝对路径 */
  path: string;
  source: 'disk' | 'queue';
  /** 显示的写入者 */
  agent: string;
  reason: string;
  /** 比较的两边：disk 是基线和磁盘内容；queue 是磁盘内容和队列里的提议 */
  base: string;
  proposed: string;
  hunks: Hunk[];
  /** 最近一次变化落在哪一处、什么时候（"正在写入"） */
  writing: { hunk: number; at: number } | null;
}

export interface MergeState {
  path: string;
  merge: Merge;
  /** Agent 写到磁盘上的版本和它的文件戳 */
  theirs: string;
  stamp: Stamp;
  agent: string;
}

/** 写入者推断：连着好几个 Agent 时，看谁最近 2 分钟内有活动 */
const INFER_WINDOW_MS = 2 * 60 * 1000;

/**
 * 直接写磁盘的改动是谁写的：只连着一个 Agent 就算它的（Agent 多半用自带的文件工具改文件，
 * 不一定调过 MCP）；连着好几个时，取最近 2 分钟内有 MCP 活动的那个；都没有就是"外部程序"。
 */
export async function guessAgent(): Promise<string> {
  try {
    const agents = await deps.backend.agentsGet();
    if (!agents.length) return t.externalProgram;
    if (agents.length === 1) return t.inferredAgent(agents[0]!.name);
    const names = new Set(agents.map((a) => a.name));
    const now = Date.now();
    const recent = (await deps.backend.activityGet(50))
      .filter((a) => names.has(a.agent) && now - a.atMs < INFER_WINDOW_MS)
      .sort((x, y) => y.atMs - x.atMs)[0];
    return recent ? t.inferredAgent(recent.agent) : t.externalProgram;
  } catch {
    return t.externalProgram;
  }
}

/** 新出现（或内容变了）的那一处：用来标"正在写入"并自动滚动过去 */
function changedHunk(prev: ReviewState | null, next: { path: string; hunks: Hunk[] }): number {
  if (!prev || prev.path !== next.path) return -1;
  const seen = new Set(prev.hunks.map((h) => h.added.join('\n')));
  for (let i = next.hunks.length - 1; i >= 0; i--) {
    if (!seen.has(next.hunks[i]!.added.join('\n'))) return i;
  }
  return -1;
}

let refreshSeq = 0;

/** 重新计算当前文件的审阅状态（打开、保存、外部修改、队列变化后调用） */
export async function refreshReview(): Promise<void> {
  const seq = ++refreshSeq;
  const s = useApp.getState();
  const path = s.filePath;
  if (!path || !s.folder || relInVault(path) === null || s.dirty) {
    if (!path || relInVault(path) === null) useApp.setState({ review: null });
    return;
  }
  let data;
  let config;
  try {
    [data, config] = await Promise.all([deps.backend.reviewGet(path), deps.backend.vaultConfigGet()]);
  } catch {
    return;
  }
  if (seq !== refreshSeq || useApp.getState().filePath !== path) return;
  const disk = useApp.getState().savedText;
  let next: Omit<ReviewState, 'writing'> | null = null;

  if (data.queued && data.queued.content !== disk) {
    next = {
      path,
      source: 'queue',
      agent: data.queued.agent,
      reason: data.queued.reason,
      base: disk,
      proposed: data.queued.content,
      hunks: diffBlocks(disk, data.queued.content).hunks,
    };
  } else if (data.queued) {
    await deps.backend.queueSet(path, null);
  }

  if (!next) {
    if (data.baseline === null) {
      // 第一次打开：当前内容就是基线
      await deps.backend.baselineSet(path, disk);
    } else if (data.baseline !== disk) {
      if (!config.review.enabled) {
        // 设置里关了审阅：外部写入直接视为已接受
        await deps.backend.baselineSet(path, disk);
        useApp.getState().setNotice({ text: t.externalReloaded });
      } else {
        next = {
          path,
          source: 'disk',
          agent: await guessAgent(),
          reason: '',
          base: data.baseline,
          proposed: disk,
          hunks: diffBlocks(data.baseline, disk).hunks,
        };
      }
    }
  }

  if (next && !next.hunks.length) {
    // 只差空行等分隔：直接接受
    if (next.source === 'disk') await deps.backend.baselineSet(path, next.proposed);
    else await writeDisk(path, next.proposed);
    next = null;
  }
  if (seq !== refreshSeq) return;
  const prev = useApp.getState().review;
  if (!next) {
    useApp.setState({ review: null });
    return;
  }
  const changed = changedHunk(prev, next);
  useApp.setState({
    review: { ...next, writing: changed >= 0 ? { hunk: changed, at: Date.now() } : null },
    reviewFocus: changed >= 0 ? changed : Math.min(useApp.getState().reviewFocus, next.hunks.length - 1),
  });
}

/** 把内容写到磁盘并更新编辑器（保留光标和滚动位置）；同时更新基线 */
async function writeDisk(path: string, text: string): Promise<boolean> {
  const s = useApp.getState();
  try {
    const stamp = await deps.backend.saveFile(path, text, s.filePath === path ? s.stamp : null);
    await deps.backend.baselineSet(path, text);
    if (useApp.getState().filePath === path) {
      useApp.getState().loadDoc({ filePath: path, text, savedText: text, stamp, dirty: false }, { keepView: true });
      await persistSession();
    }
    return true;
  } catch (e) {
    const msg = e instanceof FileError && e.kind === 'conflict' ? t.reviewDiskChanged : String(e instanceof Error ? e.message : e);
    useApp.getState().setNotice({ text: msg, error: true });
    return false;
  }
}

async function apply(kind: 'accept' | 'reject', which: number | 'all'): Promise<void> {
  const r = useApp.getState().review;
  if (!r) return;
  const hunk = which === 'all' ? null : r.hunks[which];
  if (which !== 'all' && !hunk) return;
  if (r.source === 'disk') {
    if (kind === 'accept') {
      await deps.backend.baselineSet(r.path, hunk ? acceptHunk(r.base, r.proposed, hunk) : r.proposed);
    } else {
      await writeDisk(r.path, hunk ? rejectHunk(r.base, r.proposed, hunk) : r.base);
      // writeDisk 把基线设成了写回后的内容；拒绝一处时基线应保持不变
      if (hunk) await deps.backend.baselineSet(r.path, r.base);
    }
  } else if (kind === 'accept') {
    const next = hunk ? acceptHunk(r.base, r.proposed, hunk) : r.proposed;
    if (await writeDisk(r.path, next)) {
      if (next === r.proposed) await deps.backend.queueSet(r.path, null);
    }
  } else {
    const next = hunk ? rejectHunk(r.base, r.proposed, hunk) : r.base;
    await deps.backend.queueSet(r.path, next === r.base ? null : next);
  }
  await refreshReview();
}

export const acceptChange = (i: number) => apply('accept', i);
export const rejectChange = (i: number) => apply('reject', i);
export const acceptAll = () => apply('accept', 'all');
export const rejectAll = () => apply('reject', 'all');

/** ⌥↑ / ⌥↓：上一处、下一处 */
export function focusChange(delta: number) {
  const { review, reviewFocus } = useApp.getState();
  if (!review?.hunks.length) return;
  const n = review.hunks.length;
  useApp.setState({ reviewFocus: (reviewFocus + delta + n) % n });
}

// ---------- 有未保存修改时的外部写入：三方合并 ----------

/**
 * 当前文件被外部改了，而编辑器里还有未保存的修改：以基线为共同祖先做三方合并。
 * 没有冲突就直接合并进编辑器（仍是未保存状态）；有冲突就打开"并排合并"。
 */
export async function mergeExternal(path: string, theirs: string, stamp: Stamp): Promise<void> {
  const s = useApp.getState();
  const mine = activeEditor.current && activeEditor.docId === s.docId ? activeEditor.current.getText() : s.text;
  let base = s.savedText;
  try {
    base = (await deps.backend.reviewGet(path)).baseline ?? s.savedText;
  } catch {
    // 用打开时的内容当基线
  }
  const merge = merge3(base, mine, theirs);
  const agent = await guessAgent();
  if (merge.conflicts === 0) {
    finishMerge(path, resolveMerge(merge, []), theirs, stamp);
    useApp.getState().setNotice({ text: t.mergedAuto(agent) });
    return;
  }
  useApp.setState({ merge: { path, merge, theirs, stamp, agent } });
}

/** 合并结果放进编辑器（未保存），基线和文件戳更新成 Agent 写的版本，之后保存不会再报冲突 */
function finishMerge(path: string, text: string, theirs: string, stamp: Stamp) {
  const s = useApp.getState();
  if (s.filePath !== path) return;
  s.loadDoc({ filePath: path, text, savedText: theirs, stamp, dirty: text !== theirs }, { keepView: true });
  void deps.backend.baselineSet(path, theirs);
  useApp.setState({ merge: null });
}

export function resolveConflicts(choices: ('mine' | 'theirs' | 'both')[]) {
  const m = useApp.getState().merge;
  if (!m) return;
  finishMerge(m.path, resolveMerge(m.merge, choices), m.theirs, m.stamp);
}

export function cancelMerge() {
  useApp.setState({ merge: null });
}
