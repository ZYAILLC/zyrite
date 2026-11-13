import { splitBlocks } from './blocks';

/**
 * 块级 diff 和三方合并（审阅模型、冲突合并），和编辑器用同一套顶层块切分。
 *
 * 文档看成一串"段"：每段 = 块前面的分隔（空行等）+ 块原文，最后再加末尾的原文。
 * 改动按块比较；接受或拒绝一处改动只替换对应的段，其余字节不动。
 */

interface Segmented {
  /** 每块的原文（比较用） */
  texts: string[];
  /** 每块的"分隔 + 原文"（拼接用） */
  segs: string[];
  trailing: string;
}

function segment(text: string): Segmented {
  const doc = splitBlocks(text);
  if (!doc.blocks.length) return { texts: [], segs: [], trailing: text };
  return {
    texts: doc.blocks.map((b) => b.text),
    segs: doc.blocks.map((b) => b.sepBefore + b.text),
    trailing: doc.trailing,
  };
}

/** 一处改动：base 的第 [baseFrom, baseTo) 块换成 next 的第 [nextFrom, nextTo) 块 */
export interface Hunk {
  baseFrom: number;
  baseTo: number;
  nextFrom: number;
  nextTo: number;
  /** 被删掉的块原文 */
  removed: string[];
  /** 新增的块原文 */
  added: string[];
}

export interface BlockDiff {
  hunks: Hunk[];
  /** 两边的块原文 */
  base: string[];
  next: string[];
}

/** 最长公共子序列；两边都很长时只比较首尾以外的中间部分 */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && n * m <= 4_000_000) {
    // dp[i][j] = a[start+i..endA) 和 b[start+j..endB) 的 LCS 长度
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = a[start + i] === b[start + j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j]);
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
      else j++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

export function diffBlocks(baseText: string, nextText: string): BlockDiff {
  const a = segment(baseText).texts;
  const b = segment(nextText).texts;
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  const push = (ai: number, bj: number) => {
    if (ai > i || bj > j) {
      hunks.push({ baseFrom: i, baseTo: ai, nextFrom: j, nextTo: bj, removed: a.slice(i, ai), added: b.slice(j, bj) });
    }
  };
  for (const [ai, bj] of lcsPairs(a, b)) {
    push(ai, bj);
    i = ai + 1;
    j = bj + 1;
  }
  push(a.length, b.length);
  return { hunks, base: a, next: b };
}

function join(segs: string[], trailing: string): string {
  return segs.join('') + trailing;
}


/**
 * 接受一处改动：base 里对应的块换成 next 的写法（审阅基线向 Agent 的版本前进一步）。
 * 改动挨着文末时，末尾的原文（换行）也用 next 的。
 */
export function acceptHunk(baseText: string, nextText: string, h: Hunk): string {
  const base = segment(baseText);
  const next = segment(nextText);
  const atEnd = h.baseTo === base.segs.length && h.nextTo === next.segs.length;
  return join(
    [...base.segs.slice(0, h.baseFrom), ...next.segs.slice(h.nextFrom, h.nextTo), ...base.segs.slice(h.baseTo)],
    atEnd ? next.trailing : base.trailing,
  );
}

/** 拒绝一处改动：next 里对应的块换回 base 的写法（把这一处从 Agent 的版本里撤掉） */
export function rejectHunk(baseText: string, nextText: string, h: Hunk): string {
  const base = segment(baseText);
  const next = segment(nextText);
  const atEnd = h.baseTo === base.segs.length && h.nextTo === next.segs.length;
  return join(
    [...next.segs.slice(0, h.nextFrom), ...base.segs.slice(h.baseFrom, h.baseTo), ...next.segs.slice(h.nextTo)],
    atEnd ? base.trailing : next.trailing,
  );
}

// ---------- 三方合并 ----------

export type MergeChunk =
  | { kind: 'clean'; text: string }
  /** 两边改了同一处：mine 是你的版本，theirs 是 Agent 的版本 */
  | { kind: 'conflict'; mine: string; theirs: string; base: string };

export interface Merge {
  chunks: MergeChunk[];
  conflicts: number;
}

interface SideHunk extends Hunk {
  side: 'mine' | 'theirs';
}

/**
 * 三方合并：base 是共同的祖先（审阅基线），mine 是编辑器里未保存的内容，theirs 是 Agent 写到磁盘上的。
 * 只有一边改了的地方自动合并；两边改了同一处且改法不同的是冲突，交给"并排合并"逐块选择。
 */
export function merge3(baseText: string, mineText: string, theirsText: string): Merge {
  const base = segment(baseText);
  const mine = segment(mineText);
  const theirs = segment(theirsText);
  const all: SideHunk[] = [
    ...diffBlocks(baseText, mineText).hunks.map((h) => ({ ...h, side: 'mine' as const })),
    ...diffBlocks(baseText, theirsText).hunks.map((h) => ({ ...h, side: 'theirs' as const })),
  ].sort((x, y) => x.baseFrom - y.baseFrom || x.baseTo - y.baseTo);

  // 重叠的改动归成一组（纯插入落在另一边的改动范围边上也算重叠）
  const overlaps = (g: { from: number; to: number }, h: SideHunk) =>
    h.baseFrom < g.to || (h.baseFrom === g.to && (h.baseFrom === h.baseTo || g.from === g.to));
  const groups: { from: number; to: number; hunks: SideHunk[] }[] = [];
  for (const h of all) {
    const g = groups.at(-1);
    if (g && overlaps(g, h)) {
      g.to = Math.max(g.to, h.baseTo);
      g.hunks.push(h);
    } else groups.push({ from: h.baseFrom, to: h.baseTo, hunks: [h] });
  }

  const chunks: MergeChunk[] = [];
  let conflicts = 0;
  let pos = 0;
  const pushClean = (text: string) => {
    if (!text) return;
    const last = chunks.at(-1);
    if (last?.kind === 'clean') last.text += text;
    else chunks.push({ kind: 'clean', text });
  };
  // 每一边在之前各组里净增的块数：用来把 base 的位置换算成这一边的位置
  const run = { mine: 0, theirs: 0 };
  const delta = (h: Hunk) => h.nextTo - h.nextFrom - (h.baseTo - h.baseFrom);
  for (const g of groups) {
    pushClean(base.segs.slice(pos, g.from).join(''));
    const texts = { mine: '', theirs: '' };
    for (const side of ['mine', 'theirs'] as const) {
      const segs = side === 'mine' ? mine.segs : theirs.segs;
      const groupDelta = g.hunks.filter((h) => h.side === side).reduce((n, h) => n + delta(h), 0);
      const from = g.from + run[side];
      texts[side] = segs.slice(from, g.to + run[side] + groupDelta).join('');
      run[side] += groupDelta;
    }
    const sides = new Set(g.hunks.map((h) => h.side));
    if (sides.size === 1) pushClean(sides.has('mine') ? texts.mine : texts.theirs);
    else if (texts.mine === texts.theirs) pushClean(texts.mine);
    else {
      conflicts++;
      chunks.push({ kind: 'conflict', mine: texts.mine, theirs: texts.theirs, base: base.segs.slice(g.from, g.to).join('') });
    }
    pos = g.to;
  }
  pushClean(base.segs.slice(pos).join(''));
  // 末尾的原文：两边一样就用它，否则以 Agent 写到磁盘上的为准
  const trailing = mine.trailing === theirs.trailing ? mine.trailing : theirs.trailing;
  pushClean(trailing);
  return { chunks, conflicts };
}

/**
 * 冲突处"两个都保留"：两边相同的开头几行、结尾几行只留一份，中间不同的行先放你的、再放 Agent 的。
 * 这样同一个列表里一边改了第 4 项、一边也改了第 4 项，结果是一个列表里两条第 4 项，而不是整个列表出现两遍。
 * 两边没有共同的非空行时（比如两段完全不同的文字），整段先你的、后 Agent 的。
 */
export function keepBoth(mine: string, theirs: string): string {
  const a = mine.split('\n');
  const b = theirs.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const shared = [...a.slice(0, head), ...a.slice(a.length - tail)];
  if (!shared.some((l) => l.trim())) return mine + theirs;
  return [...a.slice(0, head), ...a.slice(head, a.length - tail), ...b.slice(head, b.length - tail), ...a.slice(a.length - tail)].join('\n');
}

/** 按每处冲突的选择拼出合并结果；choices[i] 对应第 i 个冲突 */
export function resolveMerge(merge: Merge, choices: ('mine' | 'theirs' | 'both')[]): string {
  let k = 0;
  return merge.chunks
    .map((c) => {
      if (c.kind === 'clean') return c.text;
      const choice = choices[k++] ?? 'theirs';
      return choice === 'mine' ? c.mine : choice === 'theirs' ? c.theirs : keepBoth(c.mine, c.theirs);
    })
    .join('');
}
