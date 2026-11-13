import { useApp } from '../store';
import { deps } from './document';
import { dirname, isUrl, resolvePath } from './paths';

/**
 * Typora 主题兼容。编辑区沿用 Typora 的 DOM 约定（正文容器 #write、代码块 .md-fences 等），
 * 导入的 .css 改写后只作用在编辑区：
 * - `html` / `body` / `:root` / `content` 换成作用域根 `.zy-typora`（编辑区的滚动容器），变量和背景都落在这里
 * - `#write …` 前面加上作用域；其他选择器（`h1`、`.md-fences`…）限定在 `#write` 里
 * - 只用于 Typora 自己界面（侧栏、菜单、导出页）的规则丢掉，不影响 Zyrite 的界面
 * - `@import` 递归展开，`url()` 换成可以加载的地址（字体、图片在主题旁边的文件夹里）
 */

export const SCOPE = '.zy-typora';

/** Typora 界面专用的选择器（侧栏、标题栏、菜单、对话框、导出页、专注模式…），整条规则丢掉 */
const TYPORA_UI =
  /#typora-|\.typora-|\.sidebar|#sidebar|\.megamenu|#megamenu|\.mac-|\.os-windows|\.ty-|#ty-|#top-titlebar|\.md-sidebar|\.outline-|#outline|\.file-|#file-|\.modal|\.dropdown|\.context-menu|#md-notification|\.btn\b|\.on-focus-mode|\.html-for-mac|\.pin-outline|\.searchpanel|#search|\.unibody-window|#footer|\.footer-|\.popover|\.auto-suggest|\.info-panel|#toast|\.window-|\.titlebar|\.menu-|#mini-|\.mini-|\.export-|\.md-focus|\.ty-|\.typora|\.CodeMirror-search|\.md-search|(^|[\s>+~])(header|footer|nav)\b/;

const ROOT = /^\s*(?:html|body|:root|content)(?![\w-])/;

export function scopeSelector(sel: string): string | null {
  let s = sel.trim();
  if (!s || TYPORA_UI.test(s)) return null;
  if (ROOT.test(s)) {
    // 去掉开头的 html / body / :root（可以连着写，例如 `html body`、`body > #write`）
    while (ROOT.test(s)) s = s.replace(ROOT, '').replace(/^\s*>\s*/, ' ');
    // 根元素上带的类或伪类（`body.xxx`、`:root:not(...)`）基本都是 Typora 界面状态，丢掉
    if (/^[.:[#]/.test(s) && !s.startsWith('#write')) return null;
    s = s.trim();
    return s ? `${SCOPE} ${s}` : SCOPE;
  }
  if (s.startsWith('#write')) return `${SCOPE} ${s}`;
  return `${SCOPE} #write ${s}`;
}

/** url(...) 里的相对地址换掉；data:、http(s):、#id 不动 */
export function rewriteUrls(css: string, resolve: (rel: string) => string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q: string, raw: string) => {
    const u = raw.trim();
    if (/^(data:|https?:|#|blob:|asset:|file:)/i.test(u) || u.startsWith('//')) return m;
    return `url("${resolve(u)}")`;
  });
}

interface Rule {
  /** 选择器或 at-rule 的头（例如 `@media print`），没有块的语句（@import）block 为 null */
  head: string;
  block: string | null;
}

/** 顶层切分：处理注释、字符串、嵌套花括号 */
function splitRules(css: string): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  let start = 0;
  const n = css.length;
  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(css, i);
      continue;
    }
    if (c === ';') {
      const head = stripComments(css.slice(start, i)).trim();
      if (head) out.push({ head, block: null });
      start = ++i;
      continue;
    }
    if (c === '{') {
      const head = stripComments(css.slice(start, i)).trim();
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        const d = css[j];
        if (d === '"' || d === "'") {
          j = skipString(css, j);
          continue;
        }
        if (d === '/' && css[j + 1] === '*') {
          const end = css.indexOf('*/', j + 2);
          j = end < 0 ? n : end + 2;
          continue;
        }
        if (d === '{') depth++;
        else if (d === '}') depth--;
        j++;
      }
      out.push({ head, block: css.slice(i + 1, j - 1) });
      start = i = j;
      continue;
    }
    if (c === '}') {
      // 多余的右括号：跳过
      start = ++i;
      continue;
    }
    i++;
  }
  return out;
}

function skipString(css: string, i: number): number {
  const q = css[i];
  let j = i + 1;
  while (j < css.length && css[j] !== q) j += css[j] === '\\' ? 2 : 1;
  return j + 1;
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 按逗号切选择器列表（括号里的逗号不算，例如 :is(a, b)） */
function splitSelectors(head: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of head) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export interface ScopeResult {
  css: string;
  /** 需要再加载的 @import（相对地址已解析） */
  imports: string[];
}

/** 改写一份 Typora 主题 CSS（不含 @import 的内容） */
export function scopeTyporaCss(css: string, resolve: (rel: string) => string): ScopeResult {
  const imports: string[] = [];
  const walk = (src: string): string => {
    const parts: string[] = [];
    for (const { head, block } of splitRules(src)) {
      if (head.startsWith('@')) {
        const name = /^@([\w-]+)/.exec(head)?.[1]?.toLowerCase() ?? '';
        if (name === 'import') {
          const m = /^@import\s+(?:url\(\s*)?(['"]?)([^'")\s]+)\1/i.exec(head);
          const target = m?.[2];
          if (target && !/^(https?:)?\/\//i.test(target)) imports.push(target);
          continue;
        }
        if (block === null) continue; // @charset、Typora 的 @include-when-export 等
        if (name === 'media' || name === 'supports' || name === 'container' || name === 'layer') {
          // 打印样式只给 Typora 导出 PDF 用，Zyrite 导出时用自己的打印样式
          if (name === 'media' && /^\s*@media\s+print\b/i.test(head)) continue;
          const inner = walk(block);
          if (inner.trim()) parts.push(`${head}{${inner}}`);
          continue;
        }
        if (name === 'font-face') {
          parts.push(`${head}{${rewriteUrls(block, resolve)}}`);
          continue;
        }
        if (name.endsWith('keyframes')) parts.push(`${head}{${block}}`);
        continue; // @page 等
      }
      if (block === null) continue;
      const selectors = splitSelectors(head)
        .map(scopeSelector)
        .filter((s): s is string => !!s);
      if (!selectors.length) continue;
      parts.push(`${[...new Set(selectors)].join(',')}{${rewriteUrls(block, resolve)}}`);
    }
    return parts.join('\n');
  };
  return { css: walk(css), imports };
}

/** 主题文件里的相对地址 → 可以加载的 URL */
function resolverFor(cssPath: string) {
  return (rel: string) => {
    const clean = rel.split(/[?#]/)[0] ?? rel;
    if (isUrl(cssPath)) return new URL(rel, cssPath).href;
    return deps.backend.fileUrl(resolvePath(dirname(cssPath), decodeURI(clean)));
  };
}

/** 读主题文件并展开 @import，返回改写后的完整 CSS */
export async function buildTyporaCss(cssPath: string, seen = new Set<string>()): Promise<string> {
  if (seen.has(cssPath) || seen.size > 20) return '';
  seen.add(cssPath);
  const raw = await deps.backend.themeRead(cssPath);
  const { css, imports } = scopeTyporaCss(raw, resolverFor(cssPath));
  const nested: string[] = [];
  for (const rel of imports) {
    const abs = isUrl(cssPath) ? new URL(rel, cssPath).href : resolvePath(dirname(cssPath), decodeURI(rel));
    nested.push(await buildTyporaCss(abs, seen).catch(() => ''));
  }
  return [...nested, css].join('\n');
}

const STYLE_ID = 'zy-typora-theme';

/** 当前 Typora 主题改写后的 CSS（导出时也要用） */
export let typoraCss = '';

/** 应用（或去掉）Typora 主题；返回主题的背景色和文字色，界面跟着变 */
export async function applyTyporaTheme(name: string | null): Promise<{ bg: string; text: string } | null> {
  document.getElementById(STYLE_ID)?.remove();
  typoraCss = '';
  if (!name) return null;
  const file = (await deps.backend.themeList()).find((f) => f.name === name);
  if (!file) {
    useApp.setState({ typoraTheme: null });
    return null;
  }
  typoraCss = await buildTyporaCss(file.path);
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = typoraCss;
  document.head.append(style);
  // 量一下主题给正文区的背景和文字颜色
  const probe = document.createElement('div');
  probe.className = SCOPE.slice(1);
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  document.body.append(probe);
  const cs = getComputedStyle(probe);
  const result = { bg: cs.backgroundColor, text: cs.color };
  probe.remove();
  return result;
}

/** rgb()/rgba() → 亮度（0–1），透明返回 null */
export function luminanceOf(color: string): number | null {
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (!m?.[1]) return null;
  const [r = 0, g = 0, b = 0, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (a === 0) return null;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
