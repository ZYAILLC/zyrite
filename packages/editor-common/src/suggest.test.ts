import { describe, expect, it } from 'vitest';
import { matchLinkQuery } from './suggest';

describe('matchLinkQuery', () => {
  it('光标前正在输入双链', () => {
    expect(matchLinkQuery('见 [[')).toEqual({ query: '', open: 2 });
    expect(matchLinkQuery('见 [[方案')).toEqual({ query: '方案', open: 4 });
    expect(matchLinkQuery('![[图')).toEqual({ query: '图', open: 4 });
  });
  it('不是', () => {
    expect(matchLinkQuery('[[a]] 之后')).toBeNull();
    expect(matchLinkQuery('[[a|别名')).toBeNull();
    expect(matchLinkQuery('[单个')).toBeNull();
  });
});
