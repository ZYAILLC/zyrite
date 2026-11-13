import { HighlightStyle } from '@codemirror/language';
import { highlightCode, type Tag, tagHighlighter, tags as t } from '@lezer/highlight';
import { findLanguage } from './render';

/**
 * 代码块语法高亮，两种编辑器和预览栏共用。颜色取主题的 `--z-syn-*` 变量（packages/themes），
 * 切换主题不用重建编辑器，深色主题也看得清。
 *
 * 只给代码里的 token 上色：实时预览的 Markdown 本身（标题、链接、转义、行内公式等）
 * 也会经过这个高亮器，所以不映射 Markdown 用到的标签（heading、link、url、escape、special(string) 等）。
 */
const groups: { tag: Tag[]; syn: string; color: string }[] = [
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self],
    syn: 'keyword',
    color: 'var(--z-syn-keyword)',
  },
  { tag: [t.string, t.regexp, t.character, t.docString], syn: 'string', color: 'var(--z-syn-string)' },
  {
    tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit, t.color],
    syn: 'number',
    color: 'var(--z-syn-number)',
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta, t.annotation],
    syn: 'comment',
    color: 'var(--z-syn-comment)',
  },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.variableName),
      t.definition(t.function(t.variableName)),
      t.definition(t.propertyName),
      t.macroName,
      t.attributeName,
    ],
    syn: 'def',
    color: 'var(--z-syn-def)',
  },
  {
    tag: [t.typeName, t.className, t.namespace, t.tagName, t.standard(t.typeName)],
    syn: 'type',
    color: 'var(--z-syn-type)',
  },
  { tag: [t.inserted], syn: 'inserted', color: 'var(--z-review-add-text)' },
  { tag: [t.deleted, t.invalid], syn: 'deleted', color: 'var(--z-review-del-text)' },
];

/** 编辑器里用：CodeMirror 的高亮样式 */
export const codeHighlightStyle = HighlightStyle.define(groups.map((g) => ({ tag: g.tag, color: g.color })));

/** 预览栏、审阅视图里用：输出 `zy-syn-*` 类名，颜色在 content.css 里按同样的变量定义 */
const classHighlighter = tagHighlighter(groups.map((g) => ({ tag: g.tag, class: `zy-syn-${g.syn}` })));

/** 高亮结果的缓存（语言 + 代码 → HTML）：预览每次改动都整篇重新生成，没变的代码块直接复用 */
const cache = new Map<string, string>();
const CACHE_LIMIT = 300;

/** 已经缓存过的代码块：同步拿到高亮后的 HTML；没有缓存返回 undefined */
export function cachedHighlight(code: string, lang: string): string | undefined {
  return cache.get(`${lang}\u0000${code}`);
}

/**
 * 把一段代码按语言高亮成 HTML（带 `zy-syn-*` 类名的 span）。
 * 语言按需加载；不认识的语言返回 null，调用方保留原样。
 */
export async function highlightToHtml(code: string, lang: string): Promise<string | null> {
  const key = `${lang}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const desc = findLanguage(lang);
  if (!desc) return null;
  const support = desc.support ?? (await desc.load());
  const tree = support.language.parser.parse(code);
  let html = '';
  highlightCode(
    code,
    tree,
    classHighlighter,
    (text, classes) => {
      const safe = escapeHtml(text);
      html += classes ? `<span class="${classes}">${safe}</span>` : safe;
    },
    () => {
      html += '\n';
    },
  );
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, html);
  return html;
}

/**
 * 给元素里所有 `<pre><code class="language-xxx">` 上色（公式、Mermaid 除外）。
 * 有缓存的同步完成；其余异步加载语言后再上色，isCurrent 返回 false 时（内容已经重新渲染）放弃。
 */
export async function highlightCodeBlocks(root: HTMLElement, isCurrent: () => boolean = () => true): Promise<void> {
  const todo: [HTMLElement, string, string][] = [];
  for (const code of root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    const lang = /language-(\S+)/.exec(code.className)?.[1] ?? '';
    if (!lang || lang === 'math' || lang === 'mermaid') continue;
    const text = code.textContent ?? '';
    const hit = cachedHighlight(text, lang);
    if (hit !== undefined) code.innerHTML = hit;
    else todo.push([code, text, lang]);
  }
  for (const [code, text, lang] of todo) {
    const html = await highlightToHtml(text, lang).catch(() => null);
    if (!isCurrent()) return;
    if (html !== null && code.isConnected) code.innerHTML = html;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
