import type { Text } from '@codemirror/state';

export type Eol = '\n' | '\r\n';

/**
 * 文档的换行符，取第一个换行的写法。
 * CodeMirror 内部统一按行存，取全文时再用这个换行符拼回去，所以纯 LF、纯 CRLF 的文件逐字节保真；
 * LF 和 CRLF 混用的文件会统一成第一种写法（这类文件极少见）。
 */
export function detectEol(source: string): Eol {
  const i = source.indexOf('\n');
  return i > 0 && source[i - 1] === '\r' ? '\r\n' : '\n';
}

/** CodeMirror 位置 → 源码字符串偏移（CodeMirror 里换行只占 1 个位置，CRLF 在源码里占 2 个） */
export function posToOffset(doc: Text, pos: number, eol: Eol): number {
  return eol === '\n' ? pos : pos + doc.lineAt(pos).number - 1;
}

/** 源码字符串偏移 → CodeMirror 位置；落在 `\r\n` 中间时算作行尾 */
export function offsetToPos(doc: Text, offset: number, eol: Eol): number {
  if (offset <= 0) return 0;
  if (eol === '\n') return Math.min(offset, doc.length);
  let lo = 1;
  let hi = doc.lines;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (doc.line(mid).from + mid - 1 <= offset) lo = mid;
    else hi = mid - 1;
  }
  const line = doc.line(lo);
  return Math.min(line.to, offset - (lo - 1));
}
