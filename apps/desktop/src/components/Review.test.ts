import { describe, expect, it } from 'vitest';
import { lineDiff } from './Review';

describe('lineDiff', () => {
  it('改过的列表项旧的在上、新的在下，和段落一致', () => {
    const d = lineDiff(['- a', '- b', '- c'], ['- a', '- B', '- c']);
    expect(d.map((x) => `${x.kind}:${x.line}`)).toEqual(['same:- a', 'del:- b', 'add:- B', 'same:- c']);
  });

  it('末尾加一项只标出新增的那项', () => {
    const d = lineDiff(['- a', '- b'], ['- a', '- b', '- c']);
    expect(d.map((x) => x.kind)).toEqual(['same', 'same', 'add']);
  });

  it('删掉一项只标出删除的那项', () => {
    const d = lineDiff(['- a', '- b', '- c'], ['- a', '- c']);
    expect(d.map((x) => `${x.kind}:${x.line}`)).toEqual(['same:- a', 'del:- b', 'same:- c']);
  });
});
