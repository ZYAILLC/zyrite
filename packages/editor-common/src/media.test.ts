// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderEmbed, renderMarkdown } from './dom';
import { isRemoteUrl, mediaFromImage, mediaKind } from './media';

describe('mediaKind', () => {
  it('按扩展名区分视频、音频，大小写不敏感，忽略参数和锚点', () => {
    for (const f of ['a.mp4', 'b.WEBM', 'c.mov', 'd.m4v', 'e.ogv', 'clip.mp4?v=2', 'clip.mp4#t=10']) {
      expect(mediaKind(f)).toBe('video');
    }
    for (const f of ['a.mp3', 'b.wav', 'c.ogg', 'd.M4A', 'e.flac', 'f.aac']) expect(mediaKind(f)).toBe('audio');
    for (const f of ['a.png', 'mp4', 'a.mp4.md', 'a.txt', '']) expect(mediaKind(f)).toBeNull();
  });

  it('网络地址', () => {
    expect(isRemoteUrl('https://x.com/a.mp4')).toBe(true);
    expect(isRemoteUrl('HTTP://x.com/a.mp4')).toBe(true);
    expect(isRemoteUrl('//cdn.x.com/a.mp4')).toBe(true);
    expect(isRemoteUrl('media/a.mp4')).toBe(false);
    expect(isRemoteUrl('asset://localhost/a.mp4')).toBe(false);
  });
});

describe('图片语法指向视频、音频', () => {
  it('本地文件显示播放器，地址经 resolveUrl 转换', () => {
    const v = mediaFromImage('clip.mp4', '演示', (s) => `asset://${s}`) as HTMLVideoElement;
    expect(v.tagName).toBe('VIDEO');
    expect(v.controls).toBe(true);
    expect(v.getAttribute('src')).toBe('asset://clip.mp4');
    expect(v.title).toBe('演示');
    expect(mediaFromImage('song.mp3', '')?.tagName).toBe('AUDIO');
    expect(mediaFromImage('a.png', '')).toBeNull();
  });

  it('网络上的不加载，显示成链接', () => {
    const a = mediaFromImage('https://x.com/a.mp4', 'Demo', (s) => `resolved:${s}`) as HTMLAnchorElement;
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('https://x.com/a.mp4');
    expect(a.textContent).toBe('Demo');
  });

  it('renderMarkdown：播放器、链接和图片各自处理', async () => {
    const el = document.createElement('div');
    await renderMarkdown(el, '![v](a.mp4) ![s](b.mp3) ![r](https://x.com/c.webm) ![i](d.png)\n', (s) => `asset://${s}`);
    expect(el.querySelector('video')?.getAttribute('src')).toBe('asset://a.mp4');
    expect(el.querySelector('audio')?.getAttribute('src')).toBe('asset://b.mp3');
    expect(el.querySelector('a.zy-media-link')?.getAttribute('href')).toBe('https://x.com/c.webm');
    expect(el.querySelector('img')?.getAttribute('src')).toBe('asset://d.png');
  });

  it('renderMarkdown：CSV 代码块渲染成表格', async () => {
    const el = document.createElement('div');
    await renderMarkdown(el, '```csv\na,b\n1,2\n```\n');
    expect(el.querySelector('.zy-csv table th')?.textContent).toBe('a');
    expect(el.querySelector('pre')).toBeNull();
  });
});

describe('![[…]] 嵌入视频、音频', () => {
  it('显示播放器，带宽度', () => {
    const el = document.createElement('span');
    const ok = renderEmbed(el, 'clip.mp4|320', () => ({
      kind: 'media',
      media: 'video',
      src: 'asset://v/clip.mp4',
      alt: 'clip.mp4',
      width: 320,
    }));
    expect(ok).toBe(true);
    expect(el.className).toContain('zy-embed-media');
    const v = el.querySelector('video')!;
    expect(v.getAttribute('src')).toBe('asset://v/clip.mp4');
    expect(v.style.width).toBe('320px');
  });

  it('音频', () => {
    const el = document.createElement('span');
    renderEmbed(el, 'song.mp3', () => ({ kind: 'media', media: 'audio', src: 'asset://v/song.mp3', alt: 'song.mp3' }));
    expect(el.querySelector('audio')?.controls).toBe(true);
  });
});
