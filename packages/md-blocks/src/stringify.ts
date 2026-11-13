import type { AlignType, Code, Nodes, Parents, Root, RootContent, Table } from 'mdast';
import { frontmatterToMarkdown } from 'mdast-util-frontmatter';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { mathToMarkdown } from 'mdast-util-math';
import {
  defaultHandlers,
  toMarkdown,
  type Handle,
  type Handlers,
  type Info,
  type Options,
  type State,
} from 'mdast-util-to-markdown';
import { getParseOptions } from './parse';
import type { Emoji, Highlight, MdStyle, Subscript, Superscript, Tag, WikiLink } from './types';

type Opt = Partial<Options>;

/** GFM 自带的删除线处理器（输出 `~~x~~`） */
const gfmDelete = gfmToMarkdown().extensions!.find((e) => e.handlers?.delete)!.handlers!.delete as Handle;

/** 临时改 state.options，执行完恢复，用来让单个节点沿用它自己的原文风格 */
function withOptions<T>(state: State, opts: Opt, fn: () => T): T {
  const o = state.options as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined) continue;
    saved[k] = o[k];
    o[k] = v;
  }
  try {
    return fn();
  } finally {
    Object.assign(o, saved);
  }
}

function wrap(base: Handle, opts: (node: Nodes) => Opt): Handle {
  const h: Handle = (node, parent, state, info) =>
    withOptions(state, opts(node as Nodes), () => base(node, parent, state, info));
  if ('peek' in base) (h as Handle & { peek?: unknown }).peek = (base as Handle & { peek?: unknown }).peek;
  return h;
}

const zy = (node: Nodes) => node.data?.zy ?? {};

function longestRun(value: string, ch: string): number {
  let max = 0;
  let cur = 0;
  for (const c of value) {
    cur = c === ch ? cur + 1 : 0;
    if (cur > max) max = cur;
  }
  return max;
}

function code(node: Code, _parent: Parents | undefined, state: State): string {
  const hints = zy(node);
  const value = node.value;
  // 缩进式代码块（原文就是缩进写法，且没有语言标记）
  if (hints.fence === '' && !node.lang && value.trim() !== '' && !/^\s*\n/.test(value)) {
    return value
      .split('\n')
      .map((l) => (l ? `    ${l}` : l))
      .join('\n');
  }
  const preferred = hints.fence || (state.options.fence === '~' ? '~~~' : '```');
  const ch = preferred[0] ?? '`';
  const len = Math.max(preferred.length, longestRun(value, ch) + 1, 3);
  const fence = ch.repeat(len);
  const info = node.lang ? `${node.lang}${node.meta ? ` ${node.meta}` : ''}` : '';
  return `${fence}${info}\n${value ? `${value}\n` : ''}${fence}`;
}

const DELIM: Record<string, (w: number) => string> = {
  left: (w) => `:${'-'.repeat(Math.max(w - 1, 2))}`,
  right: (w) => `${'-'.repeat(Math.max(w - 1, 2))}:`,
  center: (w) => `:${'-'.repeat(Math.max(w - 2, 1))}:`,
  none: (w) => '-'.repeat(Math.max(w, 3)),
};

const width = (s: string) => [...s].length;

function parseDelimRow(row: string): AlignType[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => {
      const t = c.trim();
      const l = t.startsWith(':');
      const r = t.endsWith(':');
      return l && r ? 'center' : l ? 'left' : r ? 'right' : null;
    });
}

/** 表格：沿用原文的分隔行、首尾竖线、单元格留白和对齐方式 */
function table(node: Table, _parent: Parents | undefined, state: State, info: Info): string {
  const h = zy(node);
  const padding = h.cellPadding ?? true;
  const exit = state.enter('table');
  const rawRows = node.children.map((row) => zy(row).raw);
  const rows = node.children.map((row) => {
    const sub = state.enter('tableRow');
    const cells = row.children.map((cell) => state.handle(cell, row, state, info));
    sub();
    return cells;
  });
  exit();
  const cols = Math.max(node.align?.length ?? 0, ...rows.map((r) => r.length));
  const align = Array.from({ length: cols }, (_, i) => node.align?.[i] ?? null);
  for (const r of rows) while (r.length < cols) r.push('');

  const lead = h.outerPipes ?? true;
  const trail = h.trailingPipe ?? lead;
  const line = (cells: string[]) => {
    const inner = padding ? cells.map((c) => (c ? ` ${c} ` : ' ')).join('|') : cells.join('|');
    // 没有首尾竖线时，首尾单元格外侧的空格也去掉
    const body = padding ? inner.replace(lead ? /$^/ : /^ /, '').replace(trail ? /$^/ : / $/, '') : inner;
    return `${lead ? '|' : ''}${body}${trail ? '|' : ''}`;
  };

  const build = (minWidth: number) => {
    const widths = align.map((_, c) => Math.max(minWidth, ...rows.map((r) => width(r[c] ?? ''))));
    const pad = (text: string, c: number) => {
      if (!h.alignPipes) return text;
      const gap = widths[c]! - width(text);
      if (align[c] === 'right') return ' '.repeat(gap) + text;
      if (align[c] === 'center') return ' '.repeat(gap >> 1) + text + ' '.repeat(gap - (gap >> 1));
      return text + ' '.repeat(gap);
    };
    return { widths, lines: rows.map((r) => line(r.map((cell, c) => pad(cell, c)))) };
  };

  // 列数和对齐都没变（对齐竖线的表格还要求宽度没变）时，原样沿用分隔行
  const old = h.delimRow;
  const sameAlign =
    old !== undefined &&
    (() => {
      const a = parseDelimRow(old);
      return a.length === cols && a.every((x, i) => x === align[i]);
    })();
  let built = build(1);
  let delim: string;
  if (sameAlign && (!h.alignPipes || width(old!.trimEnd()) === width(built.lines[0] ?? ''))) {
    delim = old!;
    // 列结构没变：没改过的行原样输出
    built.lines = built.lines.map((l, i) => rawRows[i] ?? l);
  } else {
    built = build(3);
    const compact = old !== undefined && !/\s/.test(old.trim());
    const cells = align.map((a, c) => DELIM[a ?? 'none']!(h.alignPipes ? built.widths[c]! : 3));
    delim = compact ? `${lead ? '|' : ''}${cells.join('|')}${trail ? '|' : ''}` : line(cells);
  }

  const [head, ...body] = built.lines;
  return [head, delim, ...body].join('\n');
}
const handlers: Partial<Handlers> = {
  emphasis: wrap(defaultHandlers.emphasis, (n) => ({ emphasis: zy(n).marker })),
  strong: wrap(defaultHandlers.strong, (n) => ({ strong: zy(n).marker })),
  heading: ((node: Nodes, parent: Parents | undefined, state: State, info: Info) => {
    const h = zy(node);
    const out = withOptions(state, { setext: h.setext }, () =>
      defaultHandlers.heading(node as never, parent, state, info),
    );
    // setext 下划线沿用原文长度
    return h.setext && h.markup && /\n[=-]+$/.test(out) && out.at(-1) === h.markup.trim()[0]
      ? out.replace(/\n[=-]+$/, `\n${h.markup}`)
      : out;
  }) as Handle,
  table: table as unknown as Handle,
  zyRaw: ((node: { value: string }) => node.value) as unknown as Handle,
  list: wrap(defaultHandlers.list, (n) => {
    const h = zy(n);
    return {
      bullet: h.bullet,
      bulletOrdered: h.delimiter,
      incrementListMarker: h.increment,
      listItemIndent: h.itemIndent,
    };
  }),
  code: code as Handle,
  thematicBreak: ((node: Nodes, _p: Parents | undefined, state: State) =>
    zy(node).markup?.trim() || defaultHandlers.thematicBreak(node as never, _p, state)) as Handle,
  break: ((node: Nodes, parent: Parents | undefined, state: State, info: Info) => {
    const base = defaultHandlers.break(node as never, parent, state, info);
    const markup = zy(node).markup;
    return base === '\\\n' && markup && /^(\\| {2,})$/.test(markup) ? `${markup}\n` : base;
  }) as Handle,
  link: ((node: Nodes, parent: Parents | undefined, state: State, info: Info) => {
    const kind = node.type === 'link' ? zy(node).linkKind : undefined;
    if (node.type === 'link' && (kind === 'literal' || kind === 'autolink') && !node.title) {
      const only = node.children.length === 1 ? node.children[0] : undefined;
      const value = only?.type === 'text' || only?.type === 'zyRaw' ? only.value : undefined;
      if (value && node.url.endsWith(value)) return kind === 'literal' ? value : `<${value}>`;
    }
    return defaultHandlers.link(node as never, parent, state, info);
  }) as Handle,
  wikiLink: ((node: WikiLink) => `${node.embed ? '!' : ''}[[${node.value}]]`) as unknown as Handle,
  tag: ((node: Tag) => `#${node.value}`) as unknown as Handle,
  highlight: ((node: Highlight, _p: Parents | undefined, state: State, info: Info) =>
    `==${state.containerPhrasing(node as never, { ...info, before: '=', after: '=' })}==`) as unknown as Handle,
  emoji: ((node: Emoji) => `:${node.value}:`) as unknown as Handle,
  superscript: ((node: Superscript, _p: Parents | undefined, state: State, info: Info) =>
    `^${state.containerPhrasing(node as never, { ...info, before: '^', after: '^' })}^`) as unknown as Handle,
  subscript: ((node: Subscript, _p: Parents | undefined, state: State, info: Info) =>
    `~${state.containerPhrasing(node as never, { ...info, before: '~', after: '~' })}~`) as unknown as Handle,
  // 删除线沿用原文的单 / 双波浪线；打开下标后单波浪线是下标，只能写成双波浪线
  delete: ((node: Nodes, parent: Parents | undefined, state: State, info: Info) => {
    const out = gfmDelete(node, parent, state, info);
    return zy(node).strike === '~' && !getParseOptions().subscript && /^~~[^]*~~$/.test(out)
      ? `~${out.slice(2, -2)}~`
      : out;
  }) as Handle,
};

function options(style: MdStyle, table?: { alignPipes?: boolean; cellPadding?: boolean }): Options {
  return {
    bullet: style.bullet,
    bulletOrdered: style.delimiter,
    emphasis: style.emphasis,
    strong: style.strong,
    fence: style.fence.startsWith('~') ? '~' : '`',
    rule: (style.rule.trim()[0] as '*' | '-' | '_') ?? '-',
    setext: style.setext,
    listItemIndent: style.itemIndent,
    handlers,
    extensions: [
      gfmToMarkdown({ tablePipeAlign: table?.alignPipes ?? true, tableCellPadding: table?.cellPadding ?? true }),
      mathToMarkdown(),
      frontmatterToMarkdown(['yaml']),
    ],
  };
}

/**
 * 相邻的两个强调 / 加粗如果用同一种符号（`_新___的__`、`*新***的**`），解析时会粘在一起。
 * 这种情况下把后一个换成另一种符号。
 */
function separateAdjacentAttention(node: Nodes, style: MdStyle) {
  if (!('children' in node)) return;
  const kids = node.children as Nodes[];
  const markerOf = (n: Nodes) =>
    n.type === 'emphasis' ? (n.data?.zy?.marker ?? style.emphasis) : n.type === 'strong' ? (n.data?.zy?.marker ?? style.strong) : undefined;
  for (let i = 1; i < kids.length; i++) {
    const a = kids[i - 1]!;
    const b = kids[i]!;
    const ma = markerOf(a);
    if (ma && ma === markerOf(b)) {
      b.data = { ...b.data, zy: { ...b.data?.zy, marker: ma === '*' ? '_' : '*' } };
    }
  }
  for (const k of kids) separateAdjacentAttention(k, style);
}

const toEol = (text: string, eol: MdStyle['eol']) => (eol === '\n' ? text : text.replace(/\r?\n/g, eol));

/** 序列化一个顶层块，不带结尾换行，换行符按文档风格 */
export function stringifyBlock(node: RootContent, style: MdStyle): string {
  const root: Root = { type: 'root', children: [node] };
  separateAdjacentAttention(root, style);
  const zyh = (node as Nodes).data?.zy;
  const md = toMarkdown(root, options(style, zyh)).replace(/\n$/, '');
  return toEol(md, style.eol);
}

/** 序列化整棵树（用于 HTML 转 Markdown 等没有原文可保留的场景） */
export function stringifyTree(root: Root, style: MdStyle): string {
  separateAdjacentAttention(root, style);
  return toEol(toMarkdown(root, options(style)), style.eol);
}

