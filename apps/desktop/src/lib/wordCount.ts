// 中日韩文字每个字算 1，其他文字按连续的字母数字串算 1 个词。
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
const WORD = new RegExp(
  String.raw`[${CJK}]|(?:(?![${CJK}])[\p{L}\p{N}])+(?:['’-](?:(?![${CJK}])[\p{L}\p{N}])+)*`,
  'gu',
);

export function countWords(text: string): number {
  let n = 0;
  for (const _ of text.matchAll(WORD)) n++;
  return n;
}
