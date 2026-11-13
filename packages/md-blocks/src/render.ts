import type { Element, ElementContent, Root as HastRoot, Text } from 'hast';
import { toHtml } from 'hast-util-to-html';
import type { Nodes } from 'mdast';
import { type State, toHast } from 'mdast-util-to-hast';
import { emojiByName } from './emoji';
import { parseMarkdown } from './parse';
import type { Emoji, Highlight, Subscript, Superscript, Tag, WikiLink } from './types';

/** 上标、下标：子节点包进 `<sup>` / `<sub>` */
function wrapIn(state: State, node: Superscript | Subscript, tagName: 'sup' | 'sub'): Element {
  const el: Element = {
    type: 'element',
    tagName,
    properties: {},
    children: state.all(node as unknown as Nodes) as ElementContent[],
  };
  state.patch(node as unknown as Nodes, el);
  return el;
}

/**
 * Markdown → HTML 字符串。审阅视图按块渲染、导出 HTML用。
 * - 双链渲染成 `<a class="wikilink" data-target>`，高亮 `<mark>`，标签 `<span class="tag">`，
 *   表情 `<span class="emoji" title=":名字:">`，上标 `<sup>`，下标 `<sub>`
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
          properties: {
            className: node.embed ? ['wikilink', 'embed'] : ['wikilink'],
            dataTarget: page.trim(),
            // 嵌入要用完整写法（`名字#标题|宽度`）解析
            ...(node.embed ? { dataValue: node.value } : {}),
          },
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
      emoji(state: State, node: Emoji): Element | Text {
        const char = emojiByName(node.value);
        const source = `:${node.value}:`;
        if (char === undefined) return { type: 'text', value: source };
        const el: Element = {
          type: 'element',
          tagName: 'span',
          properties: { className: ['emoji'], title: source },
          children: [{ type: 'text', value: char }],
        };
        state.patch(node as unknown as Nodes, el);
        return el;
      },
      superscript: (state: State, node: Superscript) => wrapIn(state, node, 'sup'),
      subscript: (state: State, node: Subscript) => wrapIn(state, node, 'sub'),
      zyRaw(_state: State, node: { value: string }) {
        return { type: 'raw', value: node.value };
      },
      // frontmatter 不渲染（属性在右栏显示）
      yaml: () => undefined,
    } as never,
  }) as HastRoot;
  markCallouts(hast);
  if (opts.lineAttrs) {
    for (const node of hast.children) {
      if (node.type === 'element' && node.position) node.properties.dataLine = node.position.start.line;
    }
  }
  return toHtml(hast, { allowDangerousHtml: true });
}

const CALLOUT = /^\[!([\w-]+)\]([-+]?)[ \t]*/;

/** `warning` → `Warning`、`to-do` → `To do`：callout 没写标题时用类型名当标题 */
export function calloutLabel(type: string): string {
  const s = type.replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Obsidian / GitHub 的 callout（`> [!note] 标题`）：引用块加 `data-callout`，
 * 第一行拆成标题段落 `<p class="callout-title"><span class="callout-mark">Note</span> 标题</p>`，其余是正文。
 */
function markCallouts(node: HastRoot | Element) {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.tagName === 'blockquote') toCallout(child);
    markCallouts(child);
  }
}

function toCallout(quote: Element) {
  const first = quote.children.find((c): c is Element => c.type === 'element');
  if (!first || first.tagName !== 'p') return;
  const lead = first.children[0];
  if (lead?.type !== 'text') return;
  const m = CALLOUT.exec(lead.value);
  if (!m) return;
  const type = (m[1] ?? '').toLowerCase();
  quote.properties = { ...quote.properties, dataCallout: type };

  // 第一行（到第一个换行为止）是标题，后面是正文
  const rest = [{ ...lead, value: lead.value.slice(m[0].length) }, ...first.children.slice(1)];
  const title: ElementContent[] = [];
  const body: ElementContent[] = [];
  let inBody = false;
  for (const c of rest) {
    if (inBody) {
      body.push(c);
    } else if (c.type === 'text' && c.value.includes('\n')) {
      const i = c.value.indexOf('\n');
      if (i > 0) title.push({ ...c, value: c.value.slice(0, i) });
      const after = c.value.slice(i + 1);
      if (after) body.push({ ...c, value: after });
      inBody = true;
    } else if (c.type === 'element' && c.tagName === 'br') {
      inBody = true;
    } else {
      title.push(c);
    }
  }
  const hasTitle = title.some((c) => c.type !== 'text' || c.value.trim());
  const mark: Element = {
    type: 'element',
    tagName: 'span',
    properties: { className: ['callout-mark'] },
    children: [{ type: 'text', value: calloutLabel(type) }],
  };
  const titleEl: Element = {
    type: 'element',
    tagName: 'p',
    properties: { className: ['callout-title'] },
    children: hasTitle ? [mark, { type: 'text', value: ' ' }, ...title] : [mark],
    position: first.position,
  };
  const replacement: Element[] = [titleEl];
  if (body.some((c) => c.type !== 'text' || c.value.trim())) {
    replacement.push({ type: 'element', tagName: 'p', properties: {}, children: body });
  }
  const i = quote.children.indexOf(first);
  quote.children.splice(i, 1, ...replacement);
}
