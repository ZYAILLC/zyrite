/**
 * ⌘P 的模糊匹配：查询里的字符按顺序出现在路径里就算命中（不区分大小写，空格分隔的多个词都要命中）。
 * 打分偏向：文件名命中、连续命中、在词首命中（`/`、`-`、`_`、`.`、空格之后，或驼峰的大写字母）、路径短。
 */

export interface Match {
  score: number;
  /** 命中的字符在 candidate 里的下标，用来加粗 */
  positions: number[];
}

const BOUNDARY = /[/\\\-_. ]/;

function matchWord(word: string, cand: string, lower: string, nameStart: number): Match | null {
  // 先在文件名里找，找不到再从整条路径找
  for (const start of nameStart > 0 ? [nameStart, 0] : [0]) {
    const positions: number[] = [];
    let score = 0;
    let from = start;
    let prev = -2;
    for (const ch of word) {
      const i = lower.indexOf(ch, from);
      if (i < 0) {
        positions.length = 0;
        break;
      }
      score += 1;
      if (i === prev + 1) score += 4;
      if (i === 0 || BOUNDARY.test(cand[i - 1] ?? '') || (cand[i] !== lower[i] && cand[i - 1] === lower[i - 1])) {
        score += 3;
      }
      if (i >= nameStart) score += 2;
      positions.push(i);
      prev = i;
      from = i + 1;
    }
    if (positions.length === word.length) return { score, positions };
  }
  return null;
}

export function fuzzyMatch(query: string, candidate: string): Match | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { score: 0, positions: [] };
  const lower = candidate.toLowerCase();
  const nameStart = Math.max(candidate.lastIndexOf('/'), candidate.lastIndexOf('\\')) + 1;
  let score = 0;
  const positions = new Set<number>();
  for (const w of words) {
    const m = matchWord(w, candidate, lower, nameStart);
    if (!m) return null;
    score += m.score;
    for (const p of m.positions) positions.add(p);
  }
  // 路径越短越靠前
  score -= candidate.length / 100;
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

/** 过滤并排序，返回前 limit 个 */
export function fuzzyFilter<T>(query: string, items: readonly T[], key: (item: T) => string, limit = 50) {
  const out: { item: T; match: Match }[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, key(item));
    if (match) out.push({ item, match });
  }
  out.sort((a, b) => b.match.score - a.match.score);
  return out.slice(0, limit);
}
