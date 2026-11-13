import { embedSection, type EmbedInfo, mediaKind } from '@zyrite/editor-common';
import { useApp } from '../store';
import type { TreeEntry } from './backend';
import { deps } from './document';
import { notePath } from './linkIndex';
import { basename, dirname, IMAGE_EXT, MEDIA_EXT, resolvePath } from './paths';

/**
 * `![[…]]` 嵌入（Obsidian 写法）：
 * - 图片：`![[a.png]]`、`![[assets/a.png|200]]`、`![[a.png|200x120]]`。先按当前文档所在文件夹找，再按库根目录，
 *   最后在整个库里按文件名找（多个同名时取路径最短的，和 Obsidian 一致）
 * - 视频、音频：`![[clip.mp4]]`、`![[song.mp3]]`，和图片一样找文件，显示播放器（`|宽度` 对视频生效）
 * - 笔记：`![[笔记]]`、`![[笔记#某一节]]`，按双链的规则找到笔记，读出内容（只取那一节）
 */
export function resolveEmbed(value: string): EmbedInfo | null {
  const bar = value.indexOf('|');
  const target = (bar < 0 ? value : value.slice(0, bar)).trim();
  const extra = bar < 0 ? '' : value.slice(bar + 1).trim();
  if (!target) return null;
  const { folder, filePath, tree } = useApp.getState();

  if (IMAGE_EXT.test(target) || MEDIA_EXT.test(target)) {
    const abs = findAttachment(target, folder, filePath, tree);
    if (!abs) return null;
    const size = /^(\d+)(?:\s*x\s*(\d+))?$/i.exec(extra);
    const common = {
      src: deps.backend.fileUrl(abs),
      alt: size || !extra ? basename(target) : extra,
      width: size ? Number(size[1]) : undefined,
      height: size?.[2] ? Number(size[2]) : undefined,
    };
    const media = mediaKind(target);
    return media ? { kind: 'media', media, ...common } : { kind: 'image', ...common };
  }

  const hash = target.indexOf('#');
  const name = (hash < 0 ? target : target.slice(0, hash)).trim();
  const heading = hash < 0 ? null : target.slice(hash + 1).trim() || null;
  const path = name ? notePath(name) : filePath;
  if (!path) return null;
  return {
    kind: 'note',
    title: heading ? `${basename(path).replace(/\.[^.]+$/, '')} › ${heading}` : basename(path).replace(/\.[^.]+$/, ''),
    load: async () => embedSection((await deps.backend.openFile(path)).text, heading),
    resolveUrl: (src) => deps.backend.resolveImage(src, path),
  };
}

/** 图片、视频、音频等附件：先按当前文档所在文件夹，再按库根目录，最后在整个库里按文件名找 */
function findAttachment(target: string, folder: string | null, filePath: string | null, tree: TreeEntry[] | null): string | null {
  const rel = target.replace(/^\.\//, '');
  const exists = (abs: string) => !folder || !tree || inTree(abs, folder, tree);
  if (filePath) {
    const abs = resolvePath(dirname(filePath), rel);
    if (exists(abs)) return abs;
  }
  if (!folder) return null;
  const fromRoot = resolvePath(folder, rel);
  if (tree && inTree(fromRoot, folder, tree)) return fromRoot;
  if (!tree) return fromRoot;
  const want = basename(rel).toLowerCase();
  const hits = tree.filter((e) => !e.dir && basename(e.path).toLowerCase() === want).map((e) => e.path);
  if (!hits.length) return null;
  hits.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  return resolvePath(folder, hits[0]!);
}

function inTree(abs: string, folder: string, tree: TreeEntry[]): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const root = norm(folder);
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const file = norm(abs);
  if (!file.startsWith(prefix)) return true; // 库外的文件：不在文件树里，无法判断，按存在处理
  const rel = file.slice(prefix.length);
  return tree.some((e) => !e.dir && e.path === rel);
}
