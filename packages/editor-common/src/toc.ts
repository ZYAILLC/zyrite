/**
 * `[TOC]`（Typora 写法，单独一段）：在这里显示全文的标题目录，按层级缩进，点击跳到对应标题。
 */

/** 段落文字是不是 `[TOC]`（不分大小写，前后可以有空白） */
export function isTocMarker(text: string): boolean {
  return /^\s*\[toc\]\s*$/i.test(text);
}

export interface TocHeading {
  level: number;
  text: string;
}

/** 生成目录元素；每一项是 `a.zy-toc-link`，`data-index` 是第几个标题（从 0 开始），点击由调用方处理 */
export function buildToc(headings: readonly TocHeading[]): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'zy-toc';
  nav.setAttribute('contenteditable', 'false');
  const top = Math.min(...headings.map((h) => h.level), 6);
  headings.forEach((h, i) => {
    const a = document.createElement('a');
    a.className = 'zy-toc-link';
    a.href = '#';
    a.dataset.index = String(i);
    a.style.paddingLeft = `${(h.level - top) * 16}px`;
    a.textContent = h.text || ' ';
    nav.append(a);
  });
  return nav;
}

/** 预览栏：把元素里的 `<p>[TOC]</p>` 换成目录（标题从同一个元素里取） */
export function renderTocs(root: HTMLElement) {
  const markers = [...root.querySelectorAll('p')].filter((p) => isTocMarker(p.textContent ?? '') && !p.children.length);
  if (!markers.length) return;
  const headings = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].map((h) => ({
    level: Number(h.tagName[1]),
    text: h.textContent?.trim() ?? '',
  }));
  for (const p of markers) {
    const nav = buildToc(headings);
    const line = p.getAttribute('data-line');
    if (line) nav.setAttribute('data-line', line);
    p.replaceWith(nav);
  }
}

/** 预览栏里点了目录项：滚动到第 index 个标题 */
export function revealTocTarget(root: HTMLElement, link: HTMLElement) {
  const index = Number(link.dataset.index);
  root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')[index]?.scrollIntoView({ block: 'start' });
}
