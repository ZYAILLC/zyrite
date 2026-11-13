import { describe, expect, it } from 'vitest';
import { parseFrontmatter, plainContext } from './frontmatter';

describe('parseFrontmatter', () => {
  it('常见写法', () => {
    expect(
      parseFrontmatter('---\ntitle: "方案"\ntags:\n  - moc\n  - project/zyrite\naliases: [别名一, \'别名二\']\ncreated: 2026-11-01T09:30\n---\n# 正文'),
    ).toEqual([
      { key: 'title', value: '方案' },
      { key: 'tags', value: ['moc', 'project/zyrite'] },
      { key: 'aliases', value: ['别名一', '别名二'] },
      { key: 'created', value: '2026-11-01T09:30' },
    ]);
  });

  it('没有 frontmatter 或没闭合', () => {
    expect(parseFrontmatter('# 标题\n')).toBeNull();
    expect(parseFrontmatter('---\na: 1\n')).toBeNull();
    expect(parseFrontmatter('﻿---\r\na: 1\r\n---\r\n')).toEqual([{ key: 'a', value: '1' }]);
  });

  it('嵌套结构原样显示', () => {
    expect(parseFrontmatter('---\nauthor:\n  name: Z\n  email: z@y.ai\n---\n')).toEqual([
      { key: 'author', value: 'name: Z email: z@y.ai' },
    ]);
  });
});

describe('plainContext', () => {
  it('去掉 Markdown 标记，只留文字', () => {
    expect(plainContext('差异点写进 [[zyrite-方案]] 的定位一节。 #调研')).toBe('差异点写进 zyrite-方案 的定位一节。 #调研');
    expect(plainContext('见 [方案](../方案/zyrite-方案.md) 和 [[a#标题|别名]]、![[图.png]]')).toBe('见 方案 和 别名、图.png');
    expect(plainContext('> - [ ] **加粗** _斜体_ `code` ==高亮== ~~删~~')).toBe('加粗 斜体 code 高亮 删');
    expect(plainContext('## 标题里提到 [[x]]')).toBe('标题里提到 x');
    expect(plainContext('snake_case_name 不动')).toBe('snake_case_name 不动');
  });
});
