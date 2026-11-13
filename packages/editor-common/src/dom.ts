import { parseMarkdown, renderHtml } from '@zyrite/md-blocks';
import type { Nodes, PhrasingContent, Table } from 'mdast';
import { addColorSwatches } from './color';
import { highlightCodeBlocks } from './highlight';
import { renderMath, renderMermaid } from './render';
import type { ResolveEmbed, ResolveUrl } from './types';

/** 行内 mdast → DOM（实时预览里渲染表格等块时用） */
export function renderPhrasing(nodes: readonly PhrasingContent[], parent: HTMLElement, resolveUrl?: ResolveUrl) {
  for (const n of nodes) parent.append(phrasing(n, resolveUrl));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function phrasing(n: PhrasingContent, resolveUrl?: ResolveUrl): Node {
  const wrap = (tag: keyof HTMLElementTagNameMap, cls?: string) => {
    const e = el(tag, cls);
    if ('children' in n) renderPhrasing(n.children as PhrasingContent[], e, resolveUrl);
    return e;
  };
  switch (n.type) {
    case 'text':
      return document.createTextNode(n.value);
    case 'emphasis':
      return wrap('em');
    case 'strong':
      return wrap('strong');
    case 'delete':
      return wrap('del');
    case 'highlight':
      return wrap('mark');
    case 'inlineCode': {
      const c = el('code');
      c.textContent = n.value;
      return c;
    }
    case 'link':
    case 'linkReference': {
      const a = wrap('a') as HTMLAnchorElement;
      if (n.type === 'link') a.href = n.url;
      return a;
    }
    case 'image': {
      const img = el('img');
      img.src = resolveUrl ? resolveUrl(n.url) : n.url;
      img.alt = n.alt ?? '';
      return img;
    }
    case 'inlineMath': {
      const s = el('span', 'inline-math');
      renderMath(s, n.value, false);
      return s;
    }
    case 'wikiLink': {
      const [target, alias] = n.value.split('|');
      const s = el('span', 'wikilink');
      s.textContent = alias ?? target ?? '';
      return s;
    }
    case 'tag': {
      const s = el('span', 'tag');
      s.textContent = `#${n.value}`;
      return s;
    }
    case 'break':
      return el('br');
    case 'footnoteReference': {
      const s = el('sup', 'footnote-ref');
      s.textContent = `[${n.label ?? n.identifier}]`;
      return s;
    }
    default:
      return document.createTextNode('value' in n && typeof n.value === 'string' ? n.value : '');
  }
}

/** 把一段 Markdown 表格源码渲染成 <table>；不是表格时返回 null */
export function renderTableSource(source: string, resolveUrl?: ResolveUrl): HTMLTableElement | null {
  const node = parseMarkdown(source).children[0] as Nodes | undefined;
  if (node?.type !== 'table') return null;
  const table = node as Table;
  const t = el('table');
  const thead = el('thead');
  const tbody = el('tbody');
  table.children.forEach((row, r) => {
    const tr = el('tr');
    row.children.forEach((cell, c) => {
      const td = el(r === 0 ? 'th' : 'td');
      const align = table.align?.[c];
      if (align) td.style.textAlign = align;
      renderPhrasing(cell.children, td, resolveUrl);
      tr.append(td);
    });
    (r === 0 ? thead : tbody).append(tr);
  });
  t.append(thead, tbody);
  return t;
}

/**
 * 把 Markdown 渲染进一个元素（审阅视图、导出预览用）：先生成 HTML，再补上公式、Mermaid 和图片地址。
 * 样式沿用 content.css 的正文排版（容器要在 #write 里或自带 .zy-doc）。
 */
/** 返回的 Promise 在 Mermaid 图都画完后完成（导出时要等） */
export function renderMarkdown(el: HTMLElement, markdown: string, resolveUrl?: ResolveUrl): Promise<void> {
  el.innerHTML = renderHtml(markdown);
  if (resolveUrl) {
    for (const img of el.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (src) img.src = resolveUrl(src);
    }
  }
  for (const code of el.querySelectorAll<HTMLElement>('code.language-math')) {
    const display = code.classList.contains('math-display');
    const host = display ? (code.closest('pre') ?? code) : code;
    const out = document.createElement(display ? 'div' : 'span');
    out.className = display ? 'zy-figure' : 'inline-math';
    renderMath(out, code.textContent ?? '', display);
    host.replaceWith(out);
  }
  addColorSwatches(el);
  const pending: Promise<void>[] = [highlightCodeBlocks(el)];
  for (const code of el.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
    const fig = document.createElement('div');
    fig.className = 'zy-figure zy-mermaid';
    pending.push(renderMermaid(fig, code.textContent ?? ''));
    code.parentElement?.replaceWith(fig);
  }
  return Promise.all(pending).then(() => undefined);
}

/**
 * 渲染 `![[…]]` 嵌入：图片直接显示，笔记显示成一段缩进的正文（标题 + 内容）。
 * 嵌入的笔记里再有嵌入时只显示成链接，不会无限套娃。返回 false 表示解析不了，调用方照常显示链接。
 */
export function renderEmbed(el: HTMLElement, value: string, resolve: ResolveEmbed | undefined): boolean {
  const info = resolve?.(value);
  if (!info) return false;
  if (info.kind === 'image') {
    const img = document.createElement('img');
    img.src = info.src;
    img.alt = info.alt;
    if (info.width) img.width = info.width;
    if (info.height) img.height = info.height;
    el.className = 'zy-embed zy-embed-image';
    el.replaceChildren(img);
    return true;
  }
  el.className = 'zy-embed zy-embed-note';
  const head = document.createElement('span');
  head.className = 'zy-embed-title';
  head.textContent = info.title;
  const body = document.createElement('span');
  body.className = 'zy-embed-body';
  el.replaceChildren(head, body);
  void info
    .load()
    .then((md) => renderMarkdown(body, md, info.resolveUrl))
    .catch((e: unknown) => {
      body.textContent = e instanceof Error ? e.message : String(e);
      body.classList.add('zy-embed-error');
    });
  return true;
}

/**
 * 从笔记全文里取出要嵌入的部分：去掉 frontmatter；带 `#标题` 时只取这一节（到下一个同级或更高级标题为止）。
 * 找不到标题时返回全文。
 */
export function embedSection(markdown: string, heading: string | null): string {
  let text = markdown.replace(/^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
  if (!heading) return text;
  const want = heading.trim().toLowerCase();
  const lines = text.split(/\r?\n/);
  let start = -1;
  let level = 0;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/.exec(line);
    if (!m) continue;
    const lv = m[1]!.length;
    if (start < 0) {
      if (m[2]!.trim().toLowerCase() === want) {
        start = i;
        level = lv;
      }
    } else if (lv <= level) {
      text = lines.slice(start, i).join('\n');
      return text;
    }
  }
  return start < 0 ? text : lines.slice(start).join('\n');
}
