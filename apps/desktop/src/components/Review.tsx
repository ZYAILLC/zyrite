import { renderMarkdown } from '@zyrite/editor-common';
import { splitBlocks } from '@zyrite/md-blocks';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n';
import { backend } from '../lib/backend';
import { type CommandId, formatBinding } from '../lib/keymap';
import { isMac } from '../lib/platform';
import {
  acceptAll,
  acceptChange,
  cancelMerge,
  focusChange,
  rejectAll,
  rejectChange,
  resolveConflicts,
  type ReviewState,
} from '../lib/review';
import { bindingOf, useApp } from '../store';

/** 渲染一块 Markdown（审阅、合并视图里用） */
const Block = memo(function Block({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) void renderMarkdown(ref.current, text, (src) => backend.resolveImage(src, useApp.getState().filePath));
  }, [text]);
  return <div ref={ref} className={className} />;
});

const key = (id: CommandId) => formatBinding(bindingOf(id), isMac);

// ---------- 审阅 ----------

/** 顶部一行工具条（细线分隔，不用横幅；全部接受是唯一的实心主按钮） */
export function ReviewBar() {
  const review = useApp((s) => s.review);
  const [, tick] = useState(0);
  // Agent 正在写入（4 秒内有新改动）：工具条加 writing，冷白主题在底边显示扫描线
  const writingAt = review?.writing?.at;
  useEffect(() => {
    if (!writingAt) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, 4000 - (Date.now() - writingAt)));
    return () => clearTimeout(timer);
  }, [writingAt]);
  if (!review) return null;
  const n = review.hunks.length;
  const writing = !!writingAt && Date.now() - writingAt < 4000;
  return (
    <div className={`review-bar${writing ? ' writing' : ''}`} role="status">
      <span>
        <b>{review.agent}</b> {t.reviewChangedThis} · {t.reviewPending(n)}
        {review.source === 'queue' && <span className="muted"> · {t.reviewQueued}</span>}
        {review.reason && <span className="muted"> · {review.reason}</span>}
      </span>
      <div className="review-bar-actions">
        <button type="button" onClick={() => focusChange(-1)} title={key('review.prev')}>
          {t.prevChange} {key('review.prev')}
        </button>
        <button type="button" onClick={() => focusChange(1)} title={key('review.next')}>
          {t.nextChange} {key('review.next')}
        </button>
        <button type="button" className="strong" onClick={() => void rejectAll()}>
          {t.rejectAll}
        </button>
        <button type="button" className="primary" onClick={() => void acceptAll()} title={key('review.acceptAll')}>
          {t.acceptAll}
        </button>
      </div>
    </div>
  );
}

interface Row {
  kind: 'same' | 'del' | 'add';
  text: string;
  hunk?: number;
  /** 这一处的第一行：在这里放接受 / 拒绝 */
  first?: boolean;
}

/** 每一行都是列表项（无序、有序、任务列表）的块：可以按项拆开显示 */
const LIST_LINE = /^\s*([-*+]|\d+[.)])\s/;
const isSimpleList = (text: string) => text.split('\n').every((l) => LIST_LINE.test(l));

/**
 * 按行的最长公共子序列：两个列表块之间哪些项没变、哪些删了、哪些加了。
 * 两种走法一样长时先出删除，改过的项和段落一样是旧的在上、新的在下。
 */
export function lineDiff(a: string[], b: string[]): { kind: Row['kind']; line: string }[] {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: { kind: Row['kind']; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: 'same', line: a[i]! });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out.push({ kind: 'del', line: a[i++]! });
    } else {
      out.push({ kind: 'add', line: b[j++]! });
    }
  }
  return out;
}

/**
 * 一个列表换成另一个列表：按项拆开，没变的项照常显示，只把删掉、加上的项标出来。
 * 否则在列表末尾加一项也会显示成"整个列表删掉、再整个加上"。连续同类的行合成一行显示。
 */
function listRows(removed: string, added: string, hunk: number): Row[] | null {
  if (!isSimpleList(removed) || !isSimpleList(added)) return null;
  const diff = lineDiff(removed.split('\n'), added.split('\n'));
  if (!diff.some((d) => d.kind === 'same')) return null;
  const rows: Row[] = [];
  for (const d of diff) {
    const last = rows.at(-1);
    if (last && last.kind === d.kind) last.text += `\n${d.line}`;
    else rows.push({ kind: d.kind, text: d.line, hunk });
  }
  // 接受 / 拒绝放在第一处真正改动的行上，而不是列表开头没变的项
  rows.find((r) => r.kind !== 'same')!.first = true;
  return rows;
}

function buildRows(r: ReviewState, blocks: string[]): Row[] {
  const rows: Row[] = [];
  let j = 0;
  r.hunks.forEach((h, i) => {
    for (; j < h.nextFrom; j++) rows.push({ kind: 'same', text: blocks[j]! });
    const byItem = h.removed.length === 1 && h.added.length === 1 ? listRows(h.removed[0]!, h.added[0]!, i) : null;
    if (byItem) {
      rows.push(...byItem);
      j = h.nextTo;
      return;
    }
    let first = true;
    for (const text of h.removed) {
      rows.push({ kind: 'del', text, hunk: i, first });
      first = false;
    }
    for (const text of h.added) {
      rows.push({ kind: 'add', text, hunk: i, first });
      first = false;
    }
    j = h.nextTo;
  });
  for (; j < blocks.length; j++) rows.push({ kind: 'same', text: blocks[j]! });
  return rows;
}

/** 正文：左侧 `+ −` 标记，新增浅绿底，删除浅红底加删除线，右侧逐处接受 / 拒绝 */
export function ReviewView() {
  const review = useApp((s) => s.review)!;
  const focus = useApp((s) => s.reviewFocus);
  const root = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  // Agent 版本的全部块（diff 的 next 一侧）；改动的位置由 hunks 给出
  const rows = useMemo(() => buildRows(review, splitBlocks(review.proposed).blocks.map((b) => b.text)), [review]);

  const follow = useApp((s) => s.followWriting);
  // 聚焦的那一处滚到可见；Agent 正在写入时自动跟随（设置里可关）
  useEffect(() => {
    const target = follow && review.writing && Date.now() - review.writing.at < 4000 ? review.writing.hunk : focus;
    root.current?.querySelector(`[data-hunk="${target}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus, review, follow]);

  // "正在写入"4 秒后消失
  useEffect(() => {
    if (!review.writing) return;
    const timer = setTimeout(() => tick((n) => n + 1), 4000 - (Date.now() - review.writing.at));
    return () => clearTimeout(timer);
  }, [review.writing]);
  const writingHunk = review.writing && Date.now() - review.writing.at < 4000 ? review.writing.hunk : -1;

  return (
    <div className="review" ref={root}>
      <div id="write" className="zy-doc review-doc">
        {rows.map((row, i) => (
          <div
            key={`${i}:${row.kind}`}
            className={`review-row ${row.kind}${row.hunk === writingHunk ? ' writing' : ''}${row.hunk === focus ? ' focused' : ''}`}
            data-hunk={row.first ? row.hunk : undefined}
          >
            <span className="review-gutter" aria-hidden="true">
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}
            </span>
            <Block text={row.text} className="review-block" />
            <div className="review-actions">
              {row.first && row.hunk !== undefined && (
                <>
                  {row.hunk === writingHunk && <span className="review-writing">{t.writing}</span>}
                  <button type="button" className="accept" onClick={() => void acceptChange(row.hunk!)}>
                    {t.accept}
                  </button>
                  <button type="button" onClick={() => void rejectChange(row.hunk!)}>
                    {t.reject}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 并排合并 ----------

export function MergeBar() {
  const merge = useApp((s) => s.merge);
  if (!merge) return null;
  return (
    <div className="review-bar" role="status">
      <span>
        <b className="conflict">!</b> {t.mergeTitle(merge.agent, merge.merge.conflicts)}
      </span>
      <div className="review-bar-actions">
        <button type="button" onClick={cancelMerge}>
          {t.mergeLater}
        </button>
      </div>
    </div>
  );
}

/** 冲突的地方左右并排：左边你的版本，右边 Agent 的版本，逐块选择 */
export function MergeView() {
  const merge = useApp((s) => s.merge)!;
  const [choices, setChoices] = useState<('mine' | 'theirs' | 'both' | undefined)[]>(() =>
    Array(merge.merge.conflicts).fill(undefined),
  );
  const done = choices.every(Boolean);
  let k = -1;
  return (
    <div className="review">
      <div id="write" className="zy-doc merge-doc">
        {merge.merge.chunks.map((c, i) => {
          if (c.kind === 'clean') return <Block key={i} text={c.text} className="merge-clean" />;
          const n = ++k;
          const choice = choices[n];
          const choose = (v: 'mine' | 'theirs' | 'both') => setChoices((cs) => cs.map((x, idx) => (idx === n ? v : x)));
          return (
            <section key={i} className="merge-conflict" aria-label={`${t.mergeTitle(merge.agent, 1)}`}>
              <div className="merge-sides">
                <div>
                  <div className="section-label">
                    <span className="conflict">!</span> {t.mergeMine}
                  </div>
                  <Block text={c.mine} />
                </div>
                <div>
                  <div className="section-label">{t.mergeTheirs}</div>
                  <Block text={c.theirs} />
                </div>
              </div>
              <div className="merge-choices" role="group">
                {(['mine', 'theirs', 'both'] as const).map((v) => (
                  <button key={v} type="button" aria-pressed={choice === v} onClick={() => choose(v)}>
                    {v === 'mine' ? t.mergeKeepMine : v === 'theirs' ? t.mergeKeepTheirs : t.mergeKeepBoth}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        <div className="merge-footer">
          <button
            type="button"
            className="primary"
            disabled={!done}
            onClick={() => resolveConflicts(choices as ('mine' | 'theirs' | 'both')[])}
          >
            {t.mergeApply}
          </button>
        </div>
      </div>
    </div>
  );
}
