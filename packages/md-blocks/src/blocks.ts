import type { Heading, Nodes, Root, RootContent } from 'mdast';
import { parseMarkdown } from './parse';
import { defaultStyle, type MdStyle } from './types';

/** 一个顶层块及其在源码中的区间 */
export interface SourceBlock {
  node: RootContent;
  from: number;
  to: number;
  /** 源码原文 `source.slice(from, to)` */
  text: string;
  /** 与上一个块之间的原文（通常是换行和空行）；第一个块为文档开头的内容 */
  sepBefore: string;
}

export interface BlockDoc {
  source: string;
  tree: Root;
  blocks: SourceBlock[];
  /** 最后一个块之后的原文（通常是末尾换行） */
  trailing: string;
  style: MdStyle;
}

/** 解析并按顶层块切分。各块的 sepBefore + text 依次拼接，再加 trailing，等于原文。 */
export function splitBlocks(source: string): BlockDoc {
  const tree = parseMarkdown(source);
  const blocks: SourceBlock[] = [];
  let cursor = 0;
  for (const node of tree.children) {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from === undefined || to === undefined) continue;
    blocks.push({ node, from, to, text: source.slice(from, to), sepBefore: source.slice(cursor, from) });
    cursor = to;
  }
  return { source, tree, blocks, trailing: source.slice(cursor), style: detectStyle(source, tree) };
}

/** 找到 offset 所在（或之后最近）的块序号 */
export function blockIndexAt(blocks: readonly SourceBlock[], offset: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((blocks[mid]?.to ?? 0) < offset) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo);
}

/** 文档默认风格：各项取文档里第一次出现的写法 */
export function detectStyle(source: string, tree: Root): MdStyle {
  const style: MdStyle = { ...defaultStyle };
  const lf = source.indexOf('\n');
  if (lf > 0 && source[lf - 1] === '\r') style.eol = '\r\n';

  const seen = new Set<string>();
  const visit = (node: Nodes) => {
    const zy = node.data?.zy;
    if (zy) {
      const once = (key: string, fn: () => void) => {
        if (!seen.has(key)) {
          seen.add(key);
          fn();
        }
      };
      if (node.type === 'emphasis' && zy.marker) once('em', () => (style.emphasis = zy.marker!));
      if (node.type === 'strong' && zy.marker) once('strong', () => (style.strong = zy.marker!));
      if (node.type === 'list' && zy.bullet) once('bullet', () => (style.bullet = zy.bullet!));
      if (node.type === 'list' && zy.delimiter) once('delim', () => (style.delimiter = zy.delimiter!));
      if (node.type === 'list' && zy.itemIndent) once('indent', () => (style.itemIndent = zy.itemIndent!));
      if (node.type === 'code' && zy.fence) once('fence', () => (style.fence = zy.fence!));
      if (node.type === 'thematicBreak' && zy.markup) once('rule', () => (style.rule = zy.markup!.trim()));
      if (node.type === 'heading' && (node as Heading).depth <= 2 && zy.setext !== undefined) {
        once('setext', () => (style.setext = zy.setext!));
      }
    }
    if ('children' in node) for (const c of node.children) visit(c as Nodes);
  };
  visit(tree);
  return style;
}

export interface OutlineItem {
  depth: number;
  text: string;
  /** 标题在源码中的起点 */
  offset: number;
}

/** 大纲：所有标题（含引用块、列表里的不算，只取顶层） */
export function outline(doc: BlockDoc): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const b of doc.blocks) {
    if (b.node.type === 'heading') {
      items.push({ depth: b.node.depth, text: plainText(b.node).trim(), offset: b.from });
    }
  }
  return items;
}

/** 节点的纯文本 */
export function plainText(node: Nodes): string {
  if (node.type === 'wikiLink') {
    const [target, alias] = node.value.split('|');
    return alias ?? target ?? '';
  }
  if (node.type === 'tag') return `#${node.value}`;
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node) return node.children.map((c) => plainText(c as Nodes)).join('');
  return '';
}
