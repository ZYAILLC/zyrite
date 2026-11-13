import { type DOMOutputSpec, type MarkSpec, type NodeSpec, Schema } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';

/**
 * 所见即所得的文档结构。
 *
 * 每个顶层块都有 `bid`（block id）属性：加载时等于它在原文中的块序号，编辑时 ProseMirror 会沿用属性，
 * 序列化时据此判断"这一块原来在哪、改没改"，从而只重写改过的块（见 serializer.ts）。
 * 其余带 `zy` 前缀含义的属性（marker、bullet、fence……）记录原文写法，重写时沿用。
 */

const bid = { bid: { default: null } };

const tables = tableNodes({
  tableGroup: 'block',
  cellContent: 'inline*',
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (dom) => (dom as HTMLElement).style.textAlign || null,
      setDOMAttr: (value, attrs) => {
        if (value) attrs.style = `${(attrs.style as string) ?? ''}text-align: ${value as string};`;
      },
    },
  },
});

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },

  paragraph: {
    group: 'block',
    content: 'inline*',
    attrs: { ...bid },
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },

  heading: {
    group: 'block',
    content: 'inline*',
    defining: true,
    attrs: { ...bid, level: { default: 1 }, setext: { default: null }, markup: { default: null } },
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${node.attrs.level as number}`, 0],
  },

  blockquote: {
    group: 'block',
    content: 'block+',
    defining: true,
    attrs: { ...bid },
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },

  list: {
    group: 'block',
    content: 'list_item+',
    attrs: {
      ...bid,
      ordered: { default: false },
      start: { default: 1 },
      spread: { default: false },
      bullet: { default: null },
      delimiter: { default: null },
      increment: { default: null },
      itemIndent: { default: null },
    },
    parseDOM: [
      { tag: 'ul', attrs: { ordered: false } },
      {
        tag: 'ol',
        getAttrs: (dom) => ({ ordered: true, start: Number((dom as HTMLElement).getAttribute('start') ?? 1) }),
      },
    ],
    toDOM: (node): DOMOutputSpec =>
      node.attrs.ordered
        ? ['ol', { start: node.attrs.start === 1 ? null : (node.attrs.start as number) }, 0]
        : ['ul', 0],
  },

  list_item: {
    content: 'block+',
    defining: true,
    attrs: { checked: { default: null }, spread: { default: false } },
    parseDOM: [
      {
        tag: 'li',
        getAttrs: (dom) => {
          const box = (dom as HTMLElement).querySelector(':scope > input[type=checkbox]');
          return { checked: box ? (box as HTMLInputElement).checked : null };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec =>
      node.attrs.checked === null
        ? ['li', 0]
        : ['li', { class: 'task-list-item', 'data-checked': String(node.attrs.checked) }, 0],
  },

  code_block: {
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    attrs: { ...bid, lang: { default: null }, meta: { default: null }, fence: { default: null } },
    parseDOM: [
      {
        tag: 'pre',
        preserveWhitespace: 'full',
        getAttrs: (dom) => {
          const cls = (dom as HTMLElement).querySelector('code')?.className ?? '';
          return { lang: /language-(\S+)/.exec(cls)?.[1] ?? null };
        },
      },
    ],
    toDOM: (node) => ['pre', { 'data-lang': node.attrs.lang as string | null }, ['code', 0]],
  },

  math_block: {
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    attrs: { ...bid },
    parseDOM: [{ tag: 'div.math-block', preserveWhitespace: 'full' }],
    toDOM: () => ['div', { class: 'math-block' }, 0],
  },

  /** 无法所见即所得编辑的块（HTML、引用定义、脚注定义、frontmatter），退回源码编辑 */
  raw_block: {
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    attrs: { ...bid, kind: { default: 'source' } },
    toDOM: (node) => ['pre', { class: `raw-block raw-${node.attrs.kind as string}` }, 0],
  },

  thematic_break: {
    group: 'block',
    attrs: { ...bid, markup: { default: null } },
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },

  table: {
    ...tables.table,
    attrs: {
      ...bid,
      alignPipes: { default: null },
      cellPadding: { default: null },
      outerPipes: { default: null },
      trailingPipe: { default: null },
      delimRow: { default: null },
    },
  },
  // raw / sig：行原文和加载时的内容签名，内容没变时原样输出这一行
  table_row: { ...tables.table_row, attrs: { raw: { default: null }, sig: { default: null } } },
  table_header: tables.table_header,
  table_cell: tables.table_cell,

  text: { group: 'inline' },

  image: {
    group: 'inline',
    inline: true,
    draggable: true,
    attrs: {
      src: { default: '' },
      alt: { default: null },
      title: { default: null },
      ref: { default: null },
      refType: { default: null },
      label: { default: null },
    },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          return { src: el.getAttribute('src'), alt: el.getAttribute('alt'), title: el.getAttribute('title') };
        },
      },
    ],
    toDOM: (node) => ['img', { src: node.attrs.src as string, alt: node.attrs.alt as string | null }],
  },

  hard_break: {
    group: 'inline',
    inline: true,
    selectable: false,
    attrs: { markup: { default: null } },
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },

  inline_math: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: { value: { default: '' } },
    toDOM: (node) => ['span', { class: 'inline-math' }, node.attrs.value as string],
  },

  wikilink: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: { value: { default: '' }, embed: { default: false } },
    toDOM: (node) => ['span', { class: 'wikilink' }, node.attrs.value as string],
  },

  tag: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: { value: { default: '' } },
    toDOM: (node) => ['span', { class: 'tag' }, `#${node.attrs.value as string}`],
  },

  footnote_ref: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: { label: { default: '' } },
    toDOM: (node) => ['sup', { class: 'footnote-ref' }, node.attrs.label as string],
  },

  html_inline: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: { value: { default: '' } },
    toDOM: (node) => ['code', { class: 'html-inline' }, node.attrs.value as string],
  },
};

// 顺序即嵌套顺序：链接在最外层，行内代码在最内层
const marks: Record<string, MarkSpec> = {
  link: {
    attrs: {
      href: { default: '' },
      title: { default: null },
      kind: { default: null },
      ref: { default: null },
      refType: { default: null },
      label: { default: null },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom) => ({
          href: (dom as HTMLElement).getAttribute('href'),
          title: (dom as HTMLElement).getAttribute('title'),
        }),
      },
    ],
    toDOM: (mark) => ['a', { href: mark.attrs.href as string, title: mark.attrs.title as string | null }, 0],
  },
  em: {
    attrs: { marker: { default: null } },
    parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
    toDOM: () => ['em', 0],
  },
  strong: {
    attrs: { marker: { default: null } },
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (dom) => (dom as HTMLElement).style.fontWeight !== 'normal' && null },
      { style: 'font-weight', getAttrs: (v) => /^(bold(er)?|[6-9]\d{2,})$/.test(v as string) && null },
    ],
    toDOM: () => ['strong', 0],
  },
  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }],
    toDOM: () => ['del', 0],
  },
  highlight: {
    parseDOM: [{ tag: 'mark' }],
    toDOM: () => ['mark', 0],
  },
  code: {
    code: true,
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code', 0],
  },
  /**
   * 文本段的原文（含转义、实体、行内代码的反引号）。文字没改时序列化直接输出原文，
   * 避免 `\#`、`&amp;`、`$5` 这类写法在块被编辑后变样。不在界面上体现。
   */
  src: {
    attrs: { raw: {}, value: {}, lineStart: { default: false } },
    inclusive: false,
    toDOM: () => ['span', 0],
  },
};

export const schema = new Schema({ nodes, marks });
