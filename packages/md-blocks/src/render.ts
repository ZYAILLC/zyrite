import type { Element, ElementContent, Root as HastRoot } from 'hast';
import { toHtml } from 'hast-util-to-html';
import type { Nodes } from 'mdast';
import { type State, toHast } from 'mdast-util-to-hast';
import { parseMarkdown } from './parse';
import type { Highlight, Tag, WikiLink } from './types';

/**
 * Markdown → HTML 字符串。审阅视图按块渲染、导出 HTML用。
 * - 双链渲染成 `<a class="wikilink" data-target>`，高亮 `<mark>`，标签 `<span class="tag">`
 * - 公式渲染成 `<code class="language-math math-inline|math-display">`、Mermaid 是 `<pre><code class="language-mermaid">`，
 *   由调用方在 DOM 里再用 KaTeX / Mermaid 渲染（见 editor-common 的 renderMarkdown）
 * - 原文里的 HTML 原样保留（Typora 也是这样）；应用的 CSP 禁止内联脚本，不会执行
 */
export function renderHtml(
  markdown: string,
  opts: {
    footnoteLabel?: string;
    footnoteBackLabel?: string;
    /** 给每个顶层块的元素加 `data-line`（源码起始行号，从 1 开始），预览和原文同步滚动用 */
    lineAttrs?: boolean;
  } = {},
): string {
  const tree = parseMarkdown(markdown);
  const hast = toHast(tree, {
    allowDangerousHtml: true,
    ...(opts.footnoteLabel ? { footnoteLabel: opts.footnoteLabel } : {}),
    ...(opts.footnoteBackLabel ? { footnoteBackLabel: opts.footnoteBackLabel } : {}),
    handlers: {
      wikiLink(state: State, node: WikiLink): Element {
        const [target = '', alias] = node.value.split('|');
        const page = target.split('#')[0] ?? '';
        const el: Element = {
          type: 'element',
          tagName: node.embed ? 'span' : 'a',
          properties: { className: node.embed ? ['wikilink', 'embed'] : ['wikilink'], dataTarget: page.trim() },
          children: [{ type: 'text', value: (alias ?? target).trim() }],
        };
        state.patch(node as unknown as Nodes, el);
        return el;
      },
      highlight(state: State, node: Highlight): Element {
        const el: Element = {
          type: 'element',
          tagName: 'mark',
          properties: {},
          children: state.all(node as unknown as Nodes) as ElementContent[],
        };
        state.patch(node as unknown as Nodes, el);
        return el;
      },
      tag(state: State, node: Tag): Element {
        const el: Element = {
          type: 'element',
          tagName: 'span',
          properties: { className: ['tag'] },
          children: [{ type: 'text', value: `#${node.value}` }],
        };
        state.patch(node as unknown as Nodes, el);
        return el;
      },
      zyRaw(_state: State, node: { value: string }) {
        return { type: 'raw', value: node.value };
      },
      // frontmatter 不渲染（属性在右栏显示）
      yaml: () => undefined,
    } as never,
  }) as HastRoot;
  if (opts.lineAttrs) {
    for (const node of hast.children) {
      if (node.type === 'element' && node.position) node.properties.dataLine = node.position.start.line;
    }
  }
  return toHtml(hast, { allowDangerousHtml: true });
}
