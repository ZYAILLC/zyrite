import { describe, expect, it } from 'vitest';
import { luminanceOf, rewriteUrls, scopeSelector, scopeTyporaCss } from './typoraTheme';

describe('Typora 主题改写', () => {
  it('选择器限定到编辑区', () => {
    expect(scopeSelector(':root')).toBe('.zy-typora');
    expect(scopeSelector('html body')).toBe('.zy-typora');
    expect(scopeSelector('body > #write')).toBe('.zy-typora #write');
    expect(scopeSelector('#write h1')).toBe('.zy-typora #write h1');
    expect(scopeSelector('h1')).toBe('.zy-typora #write h1');
    expect(scopeSelector('.md-fences')).toBe('.zy-typora #write .md-fences');
    expect(scopeSelector('#typora-sidebar')).toBeNull();
    expect(scopeSelector('.sidebar-tabs')).toBeNull();
    expect(scopeSelector('body.typora-export #write')).toBeNull();
    expect(scopeSelector('header, footer')).toBeNull();
    expect(scopeSelector('content')).toBe('.zy-typora');
  });

  it('整份 CSS：变量、@import、@font-face、@media、打印样式', () => {
    const css = `@charset "utf-8";
@import "night/mermaid.dark.css";
@import url("https://fonts.googleapis.com/css?family=Open+Sans");
:root { --bg-color: #363B40; --text-color: #b8bfc6; }
/* 注释 { } */
html, body { background: var(--bg-color); }
@font-face { font-family: "Open Sans"; src: url('./night/OpenSans.woff') format("woff"); }
#write { max-width: 914px; }
h1, .sidebar { font-size: 2em; }
@media (max-width: 800px) { #write { padding: 0 1em; } #typora-sidebar { display: none } }
@media print { body { background: white } }
@keyframes spin { from { transform: rotate(0) } to { transform: rotate(1turn) } }
.md-fences { background: url(img/bg.png) }
pre[lang="a{b"] { color: red }`;
    const { css: out, imports } = scopeTyporaCss(css, (rel) => `asset://t/${rel.replace(/^\.\//, '')}`);
    expect(imports).toEqual(['night/mermaid.dark.css']);
    expect(out).toContain('.zy-typora{ --bg-color: #363B40;');
    expect(out).toContain('.zy-typora{ background: var(--bg-color); }');
    expect(out).toContain('url("asset://t/night/OpenSans.woff")');
    expect(out).toContain('.zy-typora #write{ max-width: 914px; }');
    expect(out).toContain('.zy-typora #write h1{ font-size: 2em; }');
    expect(out).not.toContain('sidebar');
    expect(out).toContain('@media (max-width: 800px){.zy-typora #write{ padding: 0 1em; }}');
    expect(out).not.toContain('white');
    expect(out).toContain('@keyframes spin');
    expect(out).toContain('url("asset://t/img/bg.png")');
    expect(out).toContain('.zy-typora #write pre[lang="a{b"]{ color: red }');
  });

  it('url() 里的绝对地址不动', () => {
    const r = (s: string) => rewriteUrls(s, () => 'X');
    expect(r('url(data:image/png;base64,AA)')).toBe('url(data:image/png;base64,AA)');
    expect(r('url("https://a/b.png")')).toBe('url("https://a/b.png")');
    expect(r("url('a.png')")).toBe('url("X")');
  });

  it('背景亮度', () => {
    expect(luminanceOf('rgb(255, 255, 255)')).toBeCloseTo(1);
    expect(luminanceOf('rgb(54, 59, 64)')!).toBeLessThan(0.4);
    expect(luminanceOf('rgba(0, 0, 0, 0)')).toBeNull();
  });
});
