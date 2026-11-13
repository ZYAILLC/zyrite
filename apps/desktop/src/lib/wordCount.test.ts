import { describe, expect, it } from 'vitest';
import { countWords } from './wordCount';

describe('countWords', () => {
  it.each([
    ['', 0],
    ['   \n\t', 0],
    ['hello world', 2],
    ["don't stop-gap", 2],
    ['纸砚', 2],
    ['Zyrite 是一个编辑器', 7],
    ['用abc写', 3],
    ['## 定位\n- 第 1 条', 5],
    ['**粗体**和`code`', 4],
  ])('%j → %i', (text, expected) => {
    expect(countWords(text)).toBe(expected);
  });
});
