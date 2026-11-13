import type { ResolveUrl } from './types';

/** 视频、音频的扩展名（和应用里 paths.ts 的 MEDIA_EXT 保持一致） */
export const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i;
export const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac|aac)$/i;

export type MediaKind = 'video' | 'audio';

/** 地址指向视频还是音频（忽略 `?参数` 和 `#锚点`）；都不是时返回 null */
export function mediaKind(src: string): MediaKind | null {
  const path = src.trim().replace(/[?#].*$/, '');
  if (VIDEO_EXT.test(path)) return 'video';
  if (AUDIO_EXT.test(path)) return 'audio';
  return null;
}

/** 网络地址（http、https 或 `//` 开头）：不加载，显示成链接（CSP 也不允许加载） */
export function isRemoteUrl(src: string): boolean {
  return /^(?:https?:)?\/\//i.test(src.trim());
}

/** 带控件的播放器；label 是说明文字（`![说明](a.mp4)` 里的说明），作为提示和无障碍名称 */
export function createMedia(
  kind: MediaKind,
  url: string,
  label: string,
  size?: { width?: number; height?: number },
): HTMLVideoElement | HTMLAudioElement {
  const media = document.createElement(kind);
  media.className = `zy-media zy-${kind}`;
  media.controls = true;
  media.preload = 'metadata';
  media.src = url;
  if (label) {
    media.title = label;
    media.setAttribute('aria-label', label);
  }
  if (size?.width) media.style.width = `${size.width}px`;
  if (size?.height && kind === 'video') media.style.height = `${size.height}px`;
  return media;
}

/** 网络上的视频、音频：显示成链接，点击用浏览器打开 */
export function remoteMediaLink(src: string, label: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'zy-media-link';
  a.href = src;
  a.textContent = label || src;
  a.title = src;
  return a;
}

/**
 * 图片语法指向视频、音频（`![说明](clip.mp4)`）：本地文件经 resolveUrl 转换后显示播放器，网络地址显示成链接。
 * 不是视频、音频时返回 null，照常当图片处理。
 */
export function mediaFromImage(src: string, alt: string, resolveUrl?: ResolveUrl): HTMLElement | null {
  const kind = mediaKind(src);
  if (!kind) return null;
  if (isRemoteUrl(src)) return remoteMediaLink(src, alt);
  return createMedia(kind, resolveUrl ? resolveUrl(src) : src, alt);
}

/** 把元素里指向视频、音频的 `<img>` 换成播放器（预览栏、审阅视图用；要在改写图片地址之前调用） */
export function replaceMediaImages(root: HTMLElement, resolveUrl?: ResolveUrl) {
  for (const img of root.querySelectorAll('img')) {
    const media = mediaFromImage(img.getAttribute('src') ?? '', img.getAttribute('alt') ?? '', resolveUrl);
    if (media) img.replaceWith(media);
  }
}
