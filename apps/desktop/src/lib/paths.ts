/**
 * 路径小工具（同步、不依赖 Tauri），同时支持 `/` 和 Windows 的 `\`。
 * 只做字符串处理，不访问磁盘。
 */

const lastSep = (p: string) => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));

export function basename(path: string): string {
  return path.slice(lastSep(path) + 1);
}

/** 所在目录；没有目录部分时返回空串 */
export function dirname(path: string): string {
  const i = lastSep(path);
  if (i < 0) return '';
  // 根目录：`/a.md` → `/`，`C:\a.md` → `C:\`
  if (i === 0 || (i === 2 && path[1] === ':')) return path.slice(0, i + 1);
  return path.slice(0, i);
}

/** 链接、图片地址是不是带协议的 URL（http:、mailto:、data: 等；Windows 盘符不算） */
export function isUrl(href: string): boolean {
  return /^[a-z][a-z0-9+.-]+:/i.test(href) && !/^[a-z]:[\\/]/i.test(href);
}

export function isAbsolute(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[a-z]:[\\/]/i.test(path);
}

/** 把相对路径接到目录后面，并处理 `.` 和 `..`；分隔符沿用目录的写法 */
export function resolvePath(dir: string, rel: string): string {
  if (isAbsolute(rel) || !dir) return rel;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const root = /^(?:[a-z]:)?[\\/]/i.exec(dir)?.[0] ?? '';
  const parts = dir.slice(root.length).split(/[\\/]/).filter(Boolean);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return root.replace(/[\\/]$/, sep) + parts.join(sep);
}

/** Markdown 链接里的本地路径：去掉 `#锚点` 和 `?参数`，解码 %20 等 */
export function linkPath(href: string): string {
  const bare = href.replace(/[?#].*$/, '');
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

export const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mdx|txt)$/i;

/** 从目录 fromDir 到 to 的相对路径（分隔符用 `/`）；不在同一个盘符时返回 to 本身 */
export function relativePath(fromDir: string, to: string): string {
  const split = (p: string) => p.split(/[\\/]/).filter(Boolean);
  const drive = (p: string) => /^[a-z]:/i.exec(p)?.[0].toLowerCase() ?? '';
  if (drive(fromDir) !== drive(to)) return to.split('\\').join('/');
  const a = split(fromDir);
  const b = split(to);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => '..');
  return [...up, ...b.slice(i)].join('/') || '.';
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

/** 视频、音频（`![[clip.mp4]]`、`![](song.mp3)` 显示播放器）；和 editor-common 的 VIDEO_EXT、AUDIO_EXT 保持一致 */
export const MEDIA_EXT = /\.(mp4|webm|mov|m4v|ogv|mp3|wav|ogg|m4a|flac|aac)$/i;

/** Markdown 链接地址：反斜杠换成 `/`，空格和括号等转义，中文保持原样（和 Typora 一致） */
export function encodeLinkTarget(path: string): string {
  // encodeURIComponent 不转义括号，这里统一手动转成 %XX
  return path
    .split('\\')
    .join('/')
    .replace(/[ ()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 拖入文件生成的链接：图片用 `![]()`，其他文件用 `[]()`；路径相对于当前文档（没保存过就用绝对路径） */
export function linkForFile(file: string, docPath: string | null): string {
  const name = basename(file);
  const target = encodeLinkTarget(docPath ? relativePath(dirname(docPath), file) : file);
  const isImage = IMAGE_EXT.test(name);
  const label = (isImage || MARKDOWN_EXT.test(name) ? name.replace(/\.[^.]+$/, '') : name).replace(/[[\]]/g, '\\$&');
  return isImage ? `![${label}](${target})` : `[${label}](${target})`;
}
