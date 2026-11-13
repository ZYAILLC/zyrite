import { describe, expect, it } from 'vitest';
import { contrastRatio, migrateThemeId, nextThemeId, themeOrder, themes, themeToCssVars } from './index';

// 正文和次要文字对比度 ≥ 4.5:1
const MIN = 4.5;

describe.each(themeOrder.map((id) => themes[id]))('主题 $id', (theme) => {
  const c = theme.colors;
  const r = theme.review;

  const pairs: [label: string, fg: string, bg: string][] = [
    ['text / bg', c.text, c.bg],
    ['text / sel', c.text, c.sel],
    ['text / code', c.text, c.code],
    ['muted / bg', c.muted, c.bg],
    ['accent / bg', c.accent, c.bg],
    ['审阅新增 / 新增底', r.addText, r.addBg],
    ['审阅删除 / 删除底', r.delText, r.delBg],
    ['审阅删除 / bg', r.delText, c.bg],
    ['冲突 / bg', r.conflict, c.bg],
    ['AI 色 / bg', c.ai, c.bg],
    ['主按钮文字 / AI 色', c.onAi, c.ai],
    ['侧栏文字 / 侧栏', c.sideText, c.side],
    ['侧栏文字 / 侧栏选中', c.sideText, c.sideSel],
    ['侧栏次要 / 侧栏', c.sideMuted, c.side],
    ['侧栏强调 / 侧栏', c.sideAccent, c.side],
    ['侧栏 AI 色 / 侧栏', c.sideAi, c.side],
    ...Object.entries(theme.syntax).map(([k, v]): [string, string, string] => [`语法 ${k} / code`, v, c.code]),
  ];
  it.each(pairs)('%s ≥ 4.5', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(MIN);
  });
});

describe('工具函数', () => {
  it('对比度：黑白为 21', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  });

  it('主题循环回到第一个', () => {
    expect(nextThemeId('frost')).toBe('graphite');
    expect(nextThemeId('signal')).toBe('frost');
  });

  it('旧主题换成新主题', () => {
    expect(migrateThemeId('ink')).toBe('graphite');
    for (const id of ['paper', 'xuan', 'celadon', 'mono']) expect(migrateThemeId(id)).toBe('frost');
    expect(migrateThemeId('signal')).toBe('signal');
    expect(migrateThemeId('nope')).toBeNull();
    expect(migrateThemeId(3)).toBeNull();
  });

  it('CSS 变量命名', () => {
    const vars = themeToCssVars(themes.frost);
    expect(vars['--z-bg']).toBe('#F6F7F8');
    expect(vars['--z-link-line']).toBe('#C9D3F5');
    expect(vars['--z-side-text']).toBe('#15171A');
    expect(vars['--z-on-ai']).toBe('#FFFFFF');
    expect(vars['--z-review-add-bg']).toBe('#E3F2E8');
    expect(vars['--z-font-body']).toContain('Inter');
  });
});
