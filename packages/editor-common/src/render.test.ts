import { describe, expect, it } from 'vitest';
import { mixHex, piePalette } from './render';

describe('Mermaid 饼图配色', () => {
  it('按比例混合两个颜色', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('12 种扇区颜色，前几种是主题色，后面往文字色混，互不相同', () => {
    const base = ['#7a3e8e', '#2f6a3a', '#8f4b12', '#24508f', '#1f6466', '#2f5bea', '#5f646a'];
    const pies = piePalette(base, '#15171a');
    expect(pies).toHaveLength(12);
    expect(pies.slice(0, base.length)).toEqual(base);
    expect(new Set(pies).size).toBe(12);
    for (const c of pies) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});
