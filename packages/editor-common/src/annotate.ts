/**
 * 批注锚点：用"文本片段 + 前后文"定位，原文变动后尽量重新找到。
 * 规则和 crates/zyrite-core/src/store.rs 的 locate 一致：所有出现 text 的位置里，前后文吻合最多的那个。
 */
export interface Anchor {
  text: string;
  prefix: string;
  suffix: string;
}

/** 编辑器里要标出来的批注 */
export interface AnnotationMark {
  id: string;
  /** 正文里显示的上标编号 */
  n: number;
  anchor: Anchor;
  /** 已解决的只画淡一点的下划线 */
  resolved: boolean;
}

/** 选中的文字和它的前后文（新建批注用） */
export interface SelectionInfo {
  text: string;
  prefix: string;
  suffix: string;
  /** 选区在窗口里的位置 */
  rect: { left: number; top: number; right: number; bottom: number };
}

/** 前后文各取多少个字符 */
export const CONTEXT_CHARS = 32;

export function locateAnchor(text: string, anchor: Anchor): [number, number] | null {
  if (!anchor.text) return null;
  let best: [number, number] | null = null;
  let bestScore = -1;
  for (let at = text.indexOf(anchor.text); at >= 0; at = text.indexOf(anchor.text, at + 1)) {
    const end = at + anchor.text.length;
    let score = 0;
    for (let i = 1; i <= anchor.prefix.length && text[at - i] === anchor.prefix[anchor.prefix.length - i]; i++) score++;
    for (let i = 0; i < anchor.suffix.length && text[end + i] === anchor.suffix[i]; i++) score++;
    if (score > bestScore) {
      bestScore = score;
      best = [at, end];
    }
  }
  return best;
}

/** 从全文和选区算出锚点 */
export function anchorAt(text: string, from: number, to: number): Anchor {
  return {
    text: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - CONTEXT_CHARS), from),
    suffix: text.slice(to, to + CONTEXT_CHARS),
  };
}
