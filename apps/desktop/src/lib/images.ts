import { t } from '../i18n';
import { useApp } from '../store';
import { deps } from './document';
import { activeEditor } from './editorRef';
import { basename, dirname, encodeLinkTarget, isAbsolute, relativePath, resolvePath } from './paths';

/**
 * 图片：粘贴或拖入的图片按模板存到本地（默认 ./assets/{filename}-{yyyyMMdd-HHmmss}.png），
 * 插入相对路径；设置了图床就上传，插入图床地址（本地仍留一份）。删除图片引用时不删文件。
 */

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 模板里 `{...}` 的内容：filename 换成文档名，其余按日期格式替换（yyyy MM dd HH mm ss） */
export function expandTemplate(template: string, docPath: string | null, now: Date, ext: string, original = ''): string {
  const stem = (docPath ? basename(docPath) : t.untitled).replace(/\.[^.]+$/, '');
  const filled = template.replace(/\{([^}]*)\}/g, (_, token: string) => {
    if (token === 'filename') return stem;
    if (token === 'name') return original.replace(/\.[^.]+$/, '') || 'image';
    return token
      .replace(/yyyy/g, String(now.getFullYear()))
      .replace(/MM/g, pad(now.getMonth() + 1))
      .replace(/dd/g, pad(now.getDate()))
      .replace(/HH/g, pad(now.getHours()))
      .replace(/mm/g, pad(now.getMinutes()))
      .replace(/ss/g, pad(now.getSeconds()));
  });
  // 扩展名按图片实际格式
  const base = /\.[A-Za-z0-9]{2,5}$/.test(filled) ? filled.replace(/\.[A-Za-z0-9]{2,5}$/, '') : filled;
  return `${base}.${ext}`;
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

export function extOfMime(mime: string): string {
  return MIME_EXT[mime] ?? 'png';
}

/** 图片存到哪个目录下（模板相对于它）：当前文档所在目录；没保存过就用库的根目录 */
function baseDir(): string | null {
  const { filePath, folder } = useApp.getState();
  return filePath ? dirname(filePath) : folder;
}

/** 插入用的地址：有文档就用相对路径 */
function linkTarget(abs: string): string {
  const { filePath } = useApp.getState();
  return encodeLinkTarget(filePath ? relativePath(dirname(filePath), abs) : abs);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** 上传（设置了图床时）；失败时提示，用本地路径 */
async function maybeUpload(abs: string): Promise<string | null> {
  const prefs = useApp.getState().image;
  if (prefs.upload === 'none') return null;
  try {
    return await deps.backend.imageUpload(prefs, abs);
  } catch (e) {
    useApp.getState().setNotice({ text: t.imageUploadFailed(e instanceof Error ? e.message : String(e)), error: true });
    return null;
  }
}

function imageMarkdown(label: string, target: string): string {
  return `![${label.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '\\$&')}](${target})`;
}

/** 把粘贴的图片存下来，返回要插入的 Markdown */
export async function saveImageFile(file: Blob, name = ''): Promise<string | null> {
  const s = useApp.getState();
  const dir = baseDir();
  if (!dir) {
    s.setNotice({ text: t.imageNeedSave, error: true });
    return null;
  }
  const rel = expandTemplate(s.image.template, s.filePath, new Date(), extOfMime(file.type), name);
  const abs = isAbsolute(rel) ? rel : resolvePath(dir, rel);
  const saved = await deps.backend.imageWrite(abs, await blobToBase64(file));
  const url = await maybeUpload(saved);
  return imageMarkdown(name || basename(saved), url ?? linkTarget(saved));
}

/** 拖进来的本地图片：按设置复制到模板位置（已经在库或文档目录里的不复制），返回要插入的 Markdown */
export async function placeImagePath(path: string): Promise<string> {
  const s = useApp.getState();
  const dir = baseDir();
  let target = path;
  const inside = [s.folder, s.filePath ? dirname(s.filePath) : null].some((d) => d && path.startsWith(`${d}/`));
  if (s.image.save === 'template' && dir && !inside) {
    const ext = (/\.([^./]+)$/.exec(path)?.[1] ?? 'png').toLowerCase();
    const rel = expandTemplate(s.image.template, s.filePath, new Date(), ext, basename(path));
    target = await deps.backend.imageCopy(path, isAbsolute(rel) ? rel : resolvePath(dir, rel));
  }
  const url = await maybeUpload(target);
  return imageMarkdown(basename(path), url ?? linkTarget(target));
}

/** 编辑器里粘贴了图片：存下来后插在光标处（WebView 给的是 blob:/data: 地址时先取出内容） */
export function pasteImages(items: (File | string)[]): boolean {
  const images = items.filter((f) => typeof f === 'string' || f.type.startsWith('image/'));
  if (!images.length) return false;
  void (async () => {
    const parts: string[] = [];
    for (const f of images) {
      try {
        const blob = typeof f === 'string' ? await (await fetch(f)).blob() : f;
        const name = typeof f !== 'string' && f.name && f.name !== 'image.png' ? f.name : '';
        const md = await saveImageFile(blob, name);
        if (md) parts.push(md);
      } catch (e) {
        useApp.getState().setNotice({ text: t.imageSaveFailed(e instanceof Error ? e.message : String(e)), error: true });
      }
    }
    if (parts.length) activeEditor.current?.insertMarkdown(parts.join('\n'));
  })();
  return true;
}

/** 粘贴时网页读不到数据：从系统剪贴板读图片（WebKitGTK）；没有图片就什么都不做 */
export function pasteFromSystem(): boolean {
  void (async () => {
    const b64 = await deps.backend.clipboardImage().catch(() => null);
    if (!b64) return;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    pasteImages([new File([bytes], 'image.png', { type: 'image/png' })]);
  })();
  return true;
}
