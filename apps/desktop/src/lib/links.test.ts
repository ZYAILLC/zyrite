import { describe, expect, it } from 'vitest';
import { createResolver } from './links';

// 和 crates/zyrite-core/src/index.rs 的 双链解析 测试用例一致
const names = ['plan.md', 'docs/plan.md', 'docs/deep/arch.md', 'notes/a.md', 'v1.2 计划.md'].map((rel) => ({
  rel,
  stem: rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, ''),
  title: null,
  aliases: [],
}));
const r = createResolver(names);
const w = (t: string, from: string) => {
  const s = r.resolveWiki(t, from);
  return s.kind === 'note' ? s.rel : `<${s.kind}>`;
};

describe('双链解析', () => {
  it('和 Rust 端一致', () => {
    expect(w('plan', 'notes/a.md')).toBe('plan.md');
    expect(w('Plan', 'docs/x.md')).toBe('docs/plan.md');
    expect(w('plan.md', 'notes/a.md')).toBe('plan.md');
    expect(w('arch', 'notes/a.md')).toBe('docs/deep/arch.md');
    expect(w('deep/arch', 'docs/x.md')).toBe('docs/deep/arch.md');
    expect(w('docs/deep/arch', 'notes/a.md')).toBe('docs/deep/arch.md');
    expect(w('v1.2 计划', 'a.md')).toBe('v1.2 计划.md');
    expect(w('不存在', 'a.md')).toBe('<missing>');
    expect(w('图.png', 'a.md')).toBe('<other>');
    expect(w('', 'a.md')).toBe('<other>');
  });
});
