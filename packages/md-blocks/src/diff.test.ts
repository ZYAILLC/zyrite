import { describe, expect, it } from 'vitest';
import { acceptHunk, diffBlocks, merge3, rejectHunk, resolveMerge } from './diff';
import { renderHtml } from './render';

const base = '# 架构\n\n第一段。\n\n第二段。\n\n第三段。\n';
const next = '# 架构\n\n第一段。\n\n## 新增一节\n\n新的说明。\n\n第二段改了。\n\n第三段。\n';

describe('diffBlocks', () => {
  it('按块找出改动', () => {
    const d = diffBlocks(base, next);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toMatchObject({ removed: ['第二段。'], added: ['## 新增一节', '新的说明。', '第二段改了。'] });
    expect(diffBlocks(base, base).hunks).toEqual([]);
  });

  it('多处改动：逐处接受得到 next，逐处拒绝得到 base', () => {
    const a = 'A\n\nB\n\nC\n\nD\n';
    const b = 'A\n\nB2\n\nC\n\nD\n\nE\n';
    let d = diffBlocks(a, b);
    expect(d.hunks).toHaveLength(2);
    // 接受：基线一步步向 next 靠拢
    let baseline = a;
    while ((d = diffBlocks(baseline, b)).hunks.length) baseline = acceptHunk(baseline, b, d.hunks[0]!);
    expect(baseline).toBe(b);
    // 拒绝：Agent 的版本一步步退回 base
    let proposed = b;
    while ((d = diffBlocks(a, proposed)).hunks.length) proposed = rejectHunk(a, proposed, d.hunks[0]!);
    expect(proposed).toBe(a);
  });

  it('接受一处、拒绝另一处，互不影响', () => {
    const a = 'A\n\nB\n\nC\n';
    const b = 'A2\n\nB\n\nC2\n';
    const d = diffBlocks(a, b);
    const proposed = rejectHunk(a, b, d.hunks[1]!);
    expect(proposed).toBe('A2\n\nB\n\nC\n');
    expect(acceptHunk(a, proposed, diffBlocks(a, proposed).hunks[0]!)).toBe('A2\n\nB\n\nC\n');
  });

  it('保留 CRLF 和分隔', () => {
    const a = 'A\r\n\r\nB\r\n';
    const b = 'A\r\n\r\n\r\nX\r\n\r\nB\r\n';
    const d = diffBlocks(a, b);
    expect(acceptHunk(a, b, d.hunks[0]!)).toBe(b);
    expect(rejectHunk(a, b, d.hunks[0]!)).toBe(a);
  });
});

describe('merge3', () => {
  const b0 = 'A\n\nB\n\nC\n\nD\n';

  it('两边改了不同的地方：自动合并', () => {
    const m = merge3(b0, 'A 我改的\n\nB\n\nC\n\nD\n', 'A\n\nB\n\nC\n\nD Agent 改的\n\nE\n');
    expect(m.conflicts).toBe(0);
    expect(resolveMerge(m, [])).toBe('A 我改的\n\nB\n\nC\n\nD Agent 改的\n\nE\n');
  });

  it('两边改了同一块：冲突，按选择合并', () => {
    const m = merge3(b0, 'A\n\nB 我的\n\nC\n\nD\n', 'A\n\nB Agent 的\n\nC\n\nX\n');
    expect(m.conflicts).toBe(1);
    const c = m.chunks.find((x) => x.kind === 'conflict');
    expect(c).toMatchObject({ mine: '\n\nB 我的', theirs: '\n\nB Agent 的' });
    expect(resolveMerge(m, ['mine'])).toBe('A\n\nB 我的\n\nC\n\nX\n');
    expect(resolveMerge(m, ['theirs'])).toBe('A\n\nB Agent 的\n\nC\n\nX\n');
    // 两段完全不同：两段都留，先你的
    expect(resolveMerge(m, ['both'])).toBe('A\n\nB 我的\n\nB Agent 的\n\nC\n\nX\n');
  });

  it('两个都保留：同一个列表里相同的项只留一份', () => {
    const base = '# T\n\n1. a\n2. b\n3. c\n\nZ\n';
    const m = merge3(base, '# T\n\n1. a\n2. b\n3. c 我的\n\nZ\n', '# T\n\n1. a\n2. b\n3. c Agent 的\n\nZ\n');
    expect(m.conflicts).toBe(1);
    expect(resolveMerge(m, ['both'])).toBe('# T\n\n1. a\n2. b\n3. c 我的\n3. c Agent 的\n\nZ\n');
  });

  it('两边改法一样：不算冲突', () => {
    const same = 'A\n\nB2\n\nC\n\nD\n';
    const m = merge3(b0, same, same);
    expect(m.conflicts).toBe(0);
    expect(resolveMerge(m, [])).toBe(same);
  });

  it('一边删除、另一边在后面插入', () => {
    const m = merge3(b0, 'A\n\nC\n\nD\n', 'A\n\nB\n\nC\n\nC2\n\nD\n');
    expect(m.conflicts).toBe(0);
    expect(resolveMerge(m, [])).toBe('A\n\nC\n\nC2\n\nD\n');
  });
});

describe('renderHtml', () => {
  it('常见语法和 Obsidian 语法', () => {
    const html = renderHtml('# 标题\n\n**粗** [[笔记#节|别名]] ==高亮== #标签 $x^2$\n\n```mermaid\ngraph TD\n```\n\n---\ntitle: x\n');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>粗</strong>');
    expect(html).toContain('<a class="wikilink" data-target="笔记">别名</a>');
    expect(html).toContain('<mark>高亮</mark>');
    expect(html).toContain('<span class="tag">#标签</span>');
    expect(html).toContain('language-math');
    expect(html).toContain('language-mermaid');
  });

  it('lineAttrs 给顶层块加源码行号', () => {
    const html = renderHtml('# 标题\n\n段落\n\n- a\n- b\n', { lineAttrs: true });
    expect(html).toContain('<h1 data-line="1">标题</h1>');
    expect(html).toContain('<p data-line="3">段落</p>');
    expect(html).toContain('<ul data-line="5">');
    expect(html).not.toContain('<li data-line');
  });
});
