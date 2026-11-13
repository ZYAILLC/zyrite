import { describe, expect, it } from 'vitest';
import { clipboardFiles } from './types';

const dt = (data: Record<string, string>, files: File[] = []) =>
  ({ files, items: [], getData: (k: string) => data[k] ?? '' }) as unknown as DataTransfer;

describe('剪贴板里的图片', () => {
  it('文件优先', () => {
    const f = new File(['x'], 'a.png', { type: 'image/png' });
    expect(clipboardFiles(dt({}, [f]))).toEqual([f]);
  });
  it('WebKitGTK：只有一张 blob 图片的 HTML', () => {
    expect(clipboardFiles(dt({ 'text/html': '<meta charset="utf-8"><img src="blob:tauri://localhost/1">' }))).toEqual(['blob:tauri://localhost/1']);
  });
  it('图文混排的 HTML 不算', () => {
    expect(clipboardFiles(dt({ 'text/html': '<p>文字<img src="blob:x"></p>', 'text/plain': '文字' }))).toEqual([]);
    expect(clipboardFiles(dt({ 'text/html': '<img src="blob:y">', 'text/plain': '\uFFFC' }))).toEqual(['blob:y']);
    expect(clipboardFiles(dt({ 'text/html': '<img src="https://a/b.png">' }))).toEqual([]);
  });
});
