import { parseMarkdown, renderHtml } from '@zyrite/md-blocks';
import type { Nodes, PhrasingContent, Table } from 'mdast';
import { renderMath, renderMermaid } from './render';
import type { ResolveUrl } from './types';

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
  const pending: Promise<void>[] = [];
  for (const code of el.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
    const fig = document.createElement('div');
    fig.className = 'zy-figure zy-mermaid';
    pending.push(renderMermaid(fig, code.textContent ?? ''));
    code.parentElement?.replaceWith(fig);
  }
  return Promise.all(pending).then(() => undefined);
}
