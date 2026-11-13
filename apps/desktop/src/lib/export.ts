import { renderMermaidSvg } from '@zyrite/editor-common';
import contentCss from '@zyrite/editor-common/content.css?raw';
import { parseMarkdown, renderHtml } from '@zyrite/md-blocks';
import type { Nodes, PhrasingContent, RootContent } from 'mdast';
import { locale, t } from '../i18n';
import { useApp } from '../store';
import { deps } from './document';
import { activeEditor } from './editorRef';
import { basename, dirname, isUrl, resolvePath } from './paths';
import { typoraCss } from './typoraTheme';

/**
 * 导出：
 * - HTML：单文件，图片 base64 内嵌，带当前主题的 CSS；公式是 MathJax 生成的 SVG（不依赖字体），Mermaid 是 SVG
 * - PDF：同样的内容放进打印容器，用 WebView 打印（系统对话框里存为 PDF），纸张、边距、页眉页脚按设置
 * - Word：Markdown → 简单文档结构，公式、Mermaid、图片都转成 PNG，交给 Rust（docx-rs）生成
 */

interface Source {
  markdown: string;
  filePath: string | null;
  title: string;
}

function source(): Source {
  const s = useApp.getState();
  const markdown = activeEditor.current?.getText() ?? s.text;
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  const title = s.filePath ? basename(s.filePath).replace(/\.[^.]+$/, '') : (heading ?? t.untitled.replace(/\.md$/, ''));
  return { markdown, filePath: s.filePath, title };
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
};

/** 正文里的本地图片 → data URL；网络图片保持原地址 */
async function imageDataUrl(src: string, filePath: string | null): Promise<string | null> {
  if (!src || isUrl(src) || src.startsWith('data:')) return src || null;
  const abs = filePath ? resolvePath(dirname(filePath), decodeURI(src.split(/[?#]/)[0] ?? src)) : src;
  try {
    const b64 = await deps.backend.readBase64(abs);
    const ext = (/\.([^./]+)$/.exec(abs)?.[1] ?? 'png').toLowerCase();
    return `data:${MIME[ext] ?? 'application/octet-stream'};base64,${b64}`;
  } catch {
    return null;
  }
}

let mathModule: Promise<typeof import('./exportMath')> | undefined;
const loadMath = () => (mathModule ??= import('./exportMath'));

/** 渲染导出用的正文 HTML（公式 SVG、Mermaid SVG、图片内嵌） */
export async function renderBody(src: Source): Promise<string> {
  const root = document.createElement('div');
  root.innerHTML = renderHtml(src.markdown, { footnoteLabel: t.footnotes, footnoteBackLabel: t.footnoteBack });
  const math = root.querySelector('code.language-math') ? await loadMath() : null;
  for (const code of root.querySelectorAll<HTMLElement>('code.language-math')) {
    const display = code.classList.contains('math-display');
    const host = display ? (code.closest('pre') ?? code) : code;
    const out = document.createElement(display ? 'div' : 'span');
    out.className = display ? 'zy-math-block' : 'zy-math';
    const svg = math?.texToSvg(code.textContent ?? '', display);
    if (svg) out.innerHTML = svg;
    else out.textContent = code.textContent ?? '';
    host.replaceWith(out);
  }
  for (const code of root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
    const fig = document.createElement('div');
    fig.className = 'zy-figure';
    try {
      fig.innerHTML = await renderMermaidSvg(code.textContent ?? '');
    } catch (e) {
      fig.textContent = e instanceof Error ? e.message : String(e);
    }
    code.parentElement?.replaceWith(fig);
  }
  for (const img of root.querySelectorAll('img')) {
    const data = await imageDataUrl(img.getAttribute('src') ?? '', src.filePath);
    if (data) img.setAttribute('src', data);
  }
  return root.innerHTML;
}

/** 当前主题的 CSS 变量（--z-…、--zy-…） */
function themeVars(): string {
  const style = document.documentElement.style;
  const vars: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    if (name.startsWith('--z')) vars.push(`${name}:${style.getPropertyValue(name)}`);
  }
  return `:root{${vars.join(';')}}`;
}

const EXPORT_CSS = `
html,body{margin:0;background:var(--z-bg);color:var(--z-text)}
.zy-export{padding:48px 24px}
#write{margin:0 auto}
#write pre{background:var(--z-code);padding:12px 16px;border-radius:6px;overflow-x:auto;font-family:var(--z-font-mono);font-size:.875em;line-height:1.6}
#write pre code{background:none;padding:0;font-size:inherit}
#write .zy-math-block,#write .zy-figure{display:block;text-align:center;margin:1em 0;overflow-x:auto}
#write .zy-figure svg{max-width:100%;height:auto}
#write .zy-math svg{vertical-align:middle}
#write a.wikilink{text-decoration:none}
#write input[type=checkbox]{margin-right:.4em}
`;

function exportStyles(): string {
  return [themeVars(), contentCss, EXPORT_CSS, typoraCss].filter(Boolean).join('\n');
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 完整的单文件 HTML */
export async function buildHtml(src: Source): Promise<string> {
  const body = await renderBody(src);
  const scope = useApp.getState().typoraTheme ? ' zy-typora' : '';
  return `<!doctype html>
<html lang="${document.documentElement.lang || 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Zyrite">
<title>${esc(src.title)}</title>
<style>
${exportStyles()}
</style>
</head>
<body>
<div class="zy-export${scope}"><div id="write" class="zy-doc">
${body}
</div></div>
</body>
</html>
`;
}

function defaultExportPath(src: Source, ext: string): string {
  const name = `${src.title}.${ext}`;
  if (src.filePath) return `${dirname(src.filePath)}/${name}`;
  const folder = useApp.getState().folder;
  return folder ? `${folder}/${name}` : name;
}

function notify(text: string, error = false) {
  useApp.getState().setNotice({ text, error });
}

async function run(label: string, fn: () => Promise<string | null>) {
  try {
    const out = await fn();
    if (out) notify(t.exported(label, basename(out)));
  } catch (e) {
    notify(t.exportFailed(label, e instanceof Error ? e.message : String(e)), true);
  }
}

export function exportHtml(): Promise<void> {
  return run('HTML', async () => {
    const src = source();
    const path = await deps.backend.pickExport(defaultExportPath(src, 'html'), { name: 'HTML', extensions: ['html'] });
    if (!path) return null;
    await deps.backend.writeText(path, await buildHtml(src));
    return path;
  });
}

// ---------- PDF ----------

const PRINT_ID = 'zy-print';
const PRINT_STYLE_ID = 'zy-print-style';

/** 导出样式里 #write 的规则限定到打印容器里（主窗口里还有编辑器的 #write） */
function printScoped(): string {
  return EXPORT_CSS.trim()
    .split('\n')
    .filter((line) => line.startsWith('#write'))
    .map((line) => {
      const i = line.indexOf('{');
      const sel = line.slice(0, i).split(',').map((x) => `#${PRINT_ID} ${x.trim()}`);
      return `${sel.join(',')}${line.slice(i)}`;
    })
    .join('\n');
}

function printCss(): string {
  const { paper, margin } = useApp.getState().exportPrefs;
  return `
#${PRINT_ID}{display:none}
@page{size:${paper === 'Letter' ? 'letter' : 'A4'};margin:${margin}mm}
@media print{
  html.zy-printing,html.zy-printing body,html.zy-printing #root{height:auto!important;overflow:visible!important;background:var(--z-bg)!important}
  html.zy-printing body>:not(#${PRINT_ID}){display:none!important}
  html.zy-printing #${PRINT_ID}{display:block;color:var(--z-text);-webkit-print-color-adjust:exact;print-color-adjust:exact}
  #${PRINT_ID} #write{max-width:none;padding:0;margin:0}
  #${PRINT_ID} #write pre,#${PRINT_ID} #write table,#${PRINT_ID} #write img,#${PRINT_ID} .zy-figure{break-inside:avoid}
  #${PRINT_ID} #write h1,#${PRINT_ID} #write h2,#${PRINT_ID} #write h3{break-after:avoid}
  #${PRINT_ID} .zy-print-head,#${PRINT_ID} .zy-print-foot{font:11px var(--z-font-ui);color:var(--z-muted);height:2.2em;line-height:2.2em}
  #${PRINT_ID} .zy-print-head{text-align:right}
  #${PRINT_ID} .zy-print-foot{text-align:center}
  #${PRINT_ID} thead{display:table-header-group}
  #${PRINT_ID} tfoot{display:table-footer-group}
  #${PRINT_ID} table.zy-print-frame{width:100%;border:0;border-collapse:collapse}
  #${PRINT_ID} table.zy-print-frame>*>tr>td{padding:0;border:0}
}
${printScoped()}
${typoraCss}`;
}

export function exportPdf(): Promise<void> {
  return run('PDF', async () => {
    const src = source();
    const prefs = useApp.getState().exportPrefs;
    document.getElementById(PRINT_ID)?.remove();
    document.getElementById(PRINT_STYLE_ID)?.remove();
    const style = document.createElement('style');
    style.id = PRINT_STYLE_ID;
    style.textContent = printCss();
    const box = document.createElement('div');
    box.id = PRINT_ID;
    const head = prefs.header === 'title' ? `<div class="zy-print-head">${esc(src.title)}</div>` : '';
    const foot = prefs.footer === 'date' ? `<div class="zy-print-foot">${new Date().toLocaleDateString(locale)}</div>` : '';
    // 页眉页脚放在表格的 thead / tfoot 里，打印时每页都会重复
    const scope = useApp.getState().typoraTheme ? ' zy-typora' : '';
    box.innerHTML = `<table class="zy-print-frame"><thead><tr><td>${head}</td></tr></thead><tfoot><tr><td>${foot}</td></tr></tfoot><tbody><tr><td><div class="${scope.trim()}"><div id="write" class="zy-doc">${await renderBody(src)}</div></div></td></tr></tbody></table>`;
    document.head.append(style);
    document.body.append(box);
    document.documentElement.classList.add('zy-printing');
    // 等图片解码完再打印
    await Promise.all(
      [...box.querySelectorAll('img')].map((img) =>
        img.complete
          ? null
          : new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            }),
      ),
    );
    const cleanup = () => {
      document.documentElement.classList.remove('zy-printing');
      box.remove();
      style.remove();
    };
    window.addEventListener('afterprint', cleanup, { once: true });
    await deps.backend.printWindow();
    return null;
  });
}

// ---------- Word ----------

interface DocImage {
  png: string;
  width: number;
  height: number;
}

type Marks = Partial<Record<'bold' | 'italic' | 'strike' | 'code' | 'mark' | 'sup', boolean>>;

type DocInline = { t: 'text'; text: string; marks?: Marks; link?: string } | { t: 'image'; image: DocImage } | { t: 'break' };

type DocBlock =
  | { t: 'heading'; level: number; inlines: DocInline[] }
  | { t: 'para'; inlines: DocInline[] }
  | { t: 'code'; lang: string | null; text: string }
  | { t: 'quote'; blocks: DocBlock[] }
  | { t: 'list'; ordered: boolean; start: number; items: { checked: boolean | null; blocks: DocBlock[] }[] }
  | { t: 'table'; align: (string | null)[]; rows: DocInline[][][] }
  | { t: 'rule' }
  | { t: 'figure'; image: DocImage };

export interface DocxDoc {
  blocks: DocBlock[];
  page: { paper: string; marginMm: number; header: string | null; footer: string | null };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t.imageLoadFailed));
    img.src = src;
  });
}

/** 任意图片 → PNG（按 scale 倍画，显示尺寸是 width × height） */
async function toPng(src: string, width?: number, height?: number, scale = 2): Promise<DocImage> {
  const img = await loadImage(src);
  const w = Math.max(1, Math.round(width ?? (img.naturalWidth || 300)));
  const h = Math.max(1, Math.round(height ?? (img.naturalHeight || 150)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t.canvasUnavailable);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/png');
  return { png: url.slice(url.indexOf(',') + 1), width: w, height: h };
}

/** SVG 字符串 → PNG；宽高用 ex 时按 exPx 换算成像素 */
async function svgToPng(svg: string, exPx: number): Promise<DocImage> {
  const holder = document.createElement('div');
  holder.innerHTML = svg;
  const el = holder.querySelector('svg');
  if (!el) throw new Error(t.notSvg);
  const size = (attr: string, fallback: number) => {
    const v = el.getAttribute(attr) ?? '';
    const n = parseFloat(v);
    if (v.endsWith('ex')) return n * exPx;
    if (v.endsWith('px') || /^[\d.]+$/.test(v)) return n;
    return fallback;
  };
  const vb = (el.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const vbW = vb[2] || 400;
  const vbH = vb[3] || 300;
  const maxW = parseFloat(el.style.maxWidth) || vbW;
  const w = size('width', maxW);
  const h = el.getAttribute('height') && !el.getAttribute('height')!.endsWith('%') ? size('height', (w * vbH) / vbW) : (w * vbH) / vbW;
  el.setAttribute('width', String(w));
  el.setAttribute('height', String(h));
  el.removeAttribute('style');
  if (!el.getAttribute('xmlns')) el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const data = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(el.outerHTML)))}`;
  return toPng(data, w, h, 3);
}

/** mdast → Word 的文档结构 */
export async function buildDocx(src: Source): Promise<DocxDoc> {
  const tree = parseMarkdown(src.markdown);
  const math = /\$/.test(src.markdown) ? await loadMath() : null;
  const footnotes: DocBlock[] = [];

  const mathImage = async (tex: string, display: boolean): Promise<DocImage | null> => {
    const svg = math?.texToSvg(tex, display);
    return svg ? svgToPng(svg, display ? 7.5 : 6.5).catch(() => null) : null;
  };

  const imageOf = async (url: string): Promise<DocImage | null> => {
    const data = await imageDataUrl(url, src.filePath);
    if (!data) return null;
    if (data.startsWith('data:image/svg')) {
      return svgToPng(decodeURIComponent(escape(atob(data.slice(data.indexOf(',') + 1)))), 8).catch(() => null);
    }
    return toPng(data, undefined, undefined, 1).catch(() => null);
  };

  const inlines = async (nodes: readonly PhrasingContent[], marks: Marks = {}, link?: string): Promise<DocInline[]> => {
    const out: DocInline[] = [];
    for (const n of nodes) {
      switch (n.type) {
        case 'text':
          out.push({ t: 'text', text: n.value.replace(/\n/g, ' '), marks, link });
          break;
        case 'emphasis':
          out.push(...(await inlines(n.children, { ...marks, italic: true }, link)));
          break;
        case 'strong':
          out.push(...(await inlines(n.children, { ...marks, bold: true }, link)));
          break;
        case 'delete':
          out.push(...(await inlines(n.children, { ...marks, strike: true }, link)));
          break;
        case 'highlight':
          out.push(...(await inlines(n.children, { ...marks, mark: true }, link)));
          break;
        case 'inlineCode':
          out.push({ t: 'text', text: n.value, marks: { ...marks, code: true }, link });
          break;
        case 'link':
          out.push(...(await inlines(n.children, marks, n.url)));
          break;
        case 'linkReference':
          out.push(...(await inlines(n.children, marks, link)));
          break;
        case 'image': {
          const img = await imageOf(n.url);
          out.push(img ? { t: 'image', image: img } : { t: 'text', text: n.alt || n.url, marks, link });
          break;
        }
        case 'inlineMath': {
          const img = await mathImage(n.value, false);
          out.push(img ? { t: 'image', image: img } : { t: 'text', text: n.value, marks: { ...marks, italic: true } });
          break;
        }
        case 'wikiLink': {
          const [target = '', alias] = n.value.split('|');
          out.push({ t: 'text', text: (alias ?? target).trim(), marks, link });
          break;
        }
        case 'tag':
          out.push({ t: 'text', text: `#${n.value}`, marks, link });
          break;
        case 'break':
          out.push({ t: 'break' });
          break;
        case 'footnoteReference':
          out.push({ t: 'text', text: `[${n.label ?? n.identifier}]`, marks: { ...marks, sup: true } });
          break;
        default:
          if ('value' in n && typeof n.value === 'string') out.push({ t: 'text', text: n.value, marks, link });
          else if ('children' in n) out.push(...(await inlines(n.children as PhrasingContent[], marks, link)));
      }
    }
    return out;
  };

  const blocks = async (nodes: readonly RootContent[] | readonly Nodes[]): Promise<DocBlock[]> => {
    const out: DocBlock[] = [];
    for (const n of nodes as Nodes[]) {
      switch (n.type) {
        case 'heading':
          out.push({ t: 'heading', level: n.depth, inlines: await inlines(n.children) });
          break;
        case 'paragraph': {
          const only = n.children.length === 1 ? n.children[0] : undefined;
          if (only?.type === 'image') {
            const img = await imageOf(only.url);
            if (img) {
              out.push({ t: 'figure', image: img });
              break;
            }
          }
          out.push({ t: 'para', inlines: await inlines(n.children) });
          break;
        }
        case 'code':
          if (n.lang === 'mermaid') {
            const img = await renderMermaidSvg(n.value, false)
              .then((svg) => svgToPng(svg, 8))
              .catch(() => null);
            if (img) {
              out.push({ t: 'figure', image: img });
              break;
            }
          }
          out.push({ t: 'code', lang: n.lang ?? null, text: n.value });
          break;
        case 'math': {
          const img = await mathImage(n.value, true);
          out.push(img ? { t: 'figure', image: img } : { t: 'code', lang: 'latex', text: n.value });
          break;
        }
        case 'blockquote':
          out.push({ t: 'quote', blocks: await blocks(n.children) });
          break;
        case 'list': {
          const items = [];
          for (const item of n.children) items.push({ checked: item.checked ?? null, blocks: await blocks(item.children) });
          out.push({ t: 'list', ordered: !!n.ordered, start: n.start ?? 1, items });
          break;
        }
        case 'table': {
          const rows = [];
          for (const row of n.children) {
            const cells = [];
            for (const cell of row.children) cells.push(await inlines(cell.children));
            rows.push(cells);
          }
          out.push({ t: 'table', align: (n.align ?? []).map((a) => a ?? null), rows });
          break;
        }
        case 'thematicBreak':
          out.push({ t: 'rule' });
          break;
        case 'html':
          if (n.value.trim()) out.push({ t: 'code', lang: 'html', text: n.value });
          break;
        case 'footnoteDefinition': {
          const inner = await blocks(n.children);
          const first = inner[0];
          if (first?.t === 'para') first.inlines.unshift({ t: 'text', text: `[${n.label ?? n.identifier}] ` });
          footnotes.push(...inner);
          break;
        }
        default:
          // frontmatter、链接定义等不导出
          break;
      }
    }
    return out;
  };

  const body = await blocks(tree.children);
  if (footnotes.length) body.push({ t: 'rule' }, ...footnotes);
  const prefs = useApp.getState().exportPrefs;
  return {
    blocks: body,
    page: {
      paper: prefs.paper,
      marginMm: prefs.margin,
      header: prefs.header === 'title' ? src.title : null,
      footer: prefs.footer === 'date' ? new Date().toLocaleDateString(locale) : null,
    },
  };
}

export function exportDocx(): Promise<void> {
  return run('Word', async () => {
    const src = source();
    const path = await deps.backend.pickExport(defaultExportPath(src, 'docx'), { name: 'Word', extensions: ['docx'] });
    if (!path) return null;
    await deps.backend.exportDocx(path, await buildDocx(src));
    return path;
  });
}
