import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch } from './fuzzy';

describe('fuzzyMatch', () => {
  it('按顺序出现即命中，不区分大小写', () => {
    expect(fuzzyMatch('arch', 'docs/Architecture.md')).not.toBeNull();
    expect(fuzzyMatch('hcra', 'docs/architecture.md')).toBeNull();
    expect(fuzzyMatch('', 'a.md')).toEqual({ score: 0, positions: [] });
  });

  it('多个词都要命中', () => {
    expect(fuzzyMatch('docs plan', 'docs/plan.md')).not.toBeNull();
    expect(fuzzyMatch('docs xyz', 'docs/plan.md')).toBeNull();
  });

  it('中文', () => {
    expect(fuzzyMatch('方案', '产品/zyrite-方案.md')?.positions).toEqual([10, 11]);
  });
});

describe('fuzzyFilter', () => {
  const files = ['notes/plan-old.md', 'docs/plan.md', 'src/explain/an.md', 'plan.md'];
  it('文件名命中、连续命中、路径短的靠前', () => {
    const r = fuzzyFilter('plan', files, (f) => f).map((x) => x.item);
    expect(r[0]).toBe('plan.md');
    expect(r.slice(1, 3)).toEqual(['docs/plan.md', 'notes/plan-old.md']);
    expect(r[3]).toBe('src/explain/an.md');
  });
});
