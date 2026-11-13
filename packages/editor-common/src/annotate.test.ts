import { describe, expect, it } from 'vitest';
import { anchorAt, locateAnchor } from './annotate';

describe('批注锚点', () => {
  it('和 Rust 端一致：前后文吻合最多的那一处', () => {
    const text = '工具有五个工具。对外提供五个工具，写入进队列。';
    const [s, e] = locateAnchor(text, { text: '五个工具', prefix: '对外提供', suffix: '，写入' })!;
    expect(text.slice(0, s)).toBe('工具有五个工具。对外提供');
    expect(text.slice(s, e)).toBe('五个工具');
    expect(locateAnchor('全删了', { text: '五个工具', prefix: '', suffix: '' })).toBeNull();
  });

  it('原文前后插入了内容也能找回', () => {
    const before = '第一段。\n\n这一句要改。\n\n第三段。';
    const a = anchorAt(before, before.indexOf('要改'), before.indexOf('要改') + 2);
    const after = '新加的开头。\n\n第一段。\n\n这一句要改。\n\n第三段。';
    const [s] = locateAnchor(after, a)!;
    expect(after.slice(s, s + 2)).toBe('要改');
  });
});
