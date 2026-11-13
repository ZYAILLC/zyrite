import { Transformer } from 'markmap-lib/no-plugins';
import { describe, expect, it } from 'vitest';
import { isGraphvizLang, markmapHeight, RENDERED_LANGS, themedDot } from './diagrams';

const colors = { text: '#111111', muted: '#666666', hair: '#eeeeee' };

describe('themedDot', () => {
  it('在第一个 { 后面插入默认样式，同一行，行号不变', () => {
    const out = themedDot('digraph G {\n  a -> b\n}', colors);
    expect(out.startsWith('digraph G {graph [bgcolor="transparent"')).toBe(true);
    expect(out).toContain('node [color="#111111" fontcolor="#111111"');
    expect(out).toContain('edge [color="#666666"');
    expect(out.split('\n')).toHaveLength(3);
    expect(out.endsWith('\n  a -> b\n}')).toBe(true);
  });

  it('strict、无名图、带引号的名字（里面有 {）、前面有注释', () => {
    expect(themedDot('strict graph { a -- b }', colors)).toMatch(/^strict graph \{graph \[/);
    expect(themedDot('digraph "a{b" { x }', colors)).toMatch(/^digraph "a\{b" \{graph \[/);
    expect(themedDot('// c {\n/* d { */\n# e {\ndigraph{x}', colors)).toMatch(/digraph\{graph \[/);
  });

  it('不是图的开头时原样返回，交给 Graphviz 报错', () => {
    expect(themedDot('a -> b', colors)).toBe('a -> b');
  });
});

describe('语言名', () => {
  it('dot / graphviz；渲染成图表的语言不做代码高亮', () => {
    expect(isGraphvizLang('dot')).toBe(true);
    expect(isGraphvizLang('Graphviz')).toBe(true);
    expect(isGraphvizLang('js')).toBe(false);
    for (const l of ['math', 'mermaid', 'dot', 'graphviz', 'markmap', 'csv', 'tsv']) expect(RENDERED_LANGS.has(l)).toBe(true);
  });
});

describe('markmapHeight', () => {
  it('按叶子数估算高度，有上下限', () => {
    const { root } = new Transformer([]).transform('# Root\n## A\n- a1\n- a2\n## B\n');
    expect(markmapHeight(root)).toBe(160);
    const many = { children: Array.from({ length: 12 }, () => ({ children: [] })) };
    expect(markmapHeight(many)).toBe(12 * 28 + 40);
    const huge = { children: Array.from({ length: 100 }, () => ({ children: [] })) };
    expect(markmapHeight(huge)).toBe(480);
  });
});
