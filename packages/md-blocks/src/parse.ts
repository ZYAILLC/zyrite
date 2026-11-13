import type { Nodes, Parent, PhrasingContent, Root, Text } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { ZyHints } from './types';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkFrontmatter, ['yaml']);

/**
 * 解析 Markdown：CommonMark + GFM + 数学 + YAML frontmatter + Obsidian 行内语法（双链、高亮、标签）。
 * 每个节点带源码位置，并在 `data.zy` 上记录原文风格。
 */
export function parseMarkdown(source: string): Root {
  // micromark 会丢掉开头的 BOM，算出来的偏移少 1；去掉 BOM 解析后把所有位置往后挪 1，保证偏移对应原文
  const bom = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const tree = processor.parse(bom ? source.slice(1) : source) as Root;
  if (bom) shiftPositions(tree, bom);
  walk(tree, source);
  return tree;
}

function shiftPositions(node: Nodes, by: number) {
  const pos = node.position;
  if (pos) {
    for (const p of [pos.start, pos.end]) {
      if (p.offset !== undefined) p.offset += by;
      if (p.line === 1) p.column += by;
    }
  }
  if ('children' in node) for (const c of node.children) shiftPositions(c as Nodes, by);
}

function slice(node: Nodes, source: string): string | undefined {
  const s = node.position?.start.offset;
  const e = node.position?.end.offset;
  return s === undefined || e === undefined ? undefined : source.slice(s, e);
}

function hint(node: Nodes, h: ZyHints) {
  node.data = { ...node.data, zy: { ...node.data?.zy, ...h } };
}

const CONTAINERS = new Set(['blockquote', 'listItem', 'footnoteDefinition']);

function walk(node: Nodes, source: string, inContainer = false) {
  annotate(node, source, inContainer);
  if ('children' in node) {
    if (node.type !== 'link' && node.type !== 'linkReference') rewriteInline(node, source);
    const inner = inContainer || CONTAINERS.has(node.type);
    for (const child of node.children) walk(child as Nodes, source, inner);
  }
}

// 行首到这段文本之间只有容器标记（引用、列表、任务框）和空白
const LINE_PREFIX = /^(?:\s*(?:>\s?|[-*+]\s+|\d{1,9}[.)]\s+|\[[ xX]\]\s+))*\s*$/;

function annotateRaw(node: Nodes, source: string, inContainer: boolean) {
  const s = node.position?.start.offset;
  const e = node.position?.end.offset;
  if (s === undefined || e === undefined) return;
  // 容器（引用、列表）里跨行的原文带着 `> ` 或缩进前缀，重写时容器会再加一次，所以不记录
  if (inContainer && source.slice(s, e).includes('\n')) return;
  const lineBegin = source.lastIndexOf('\n', s - 1) + 1;
  hint(node, { raw: source.slice(s, e), lineStart: LINE_PREFIX.test(source.slice(lineBegin, s)) });
}

function annotate(node: Nodes, source: string, inContainer: boolean) {
  const raw = slice(node, source);
  if (raw === undefined) return;
  switch (node.type) {
    case 'emphasis':
    case 'strong':
      hint(node, { marker: raw[0] === '_' ? '_' : '*' });
      break;
    case 'heading': {
      const setext = !/^ {0,3}#/.test(raw);
      hint(node, setext ? { setext, markup: /[=-]+[ \t]*$/.exec(raw)?.[0] } : { setext });
      break;
    }
    case 'text':
    case 'inlineCode':
      annotateRaw(node, source, inContainer);
      break;
    case 'tableRow':
      hint(node, { raw });
      break;
    case 'code': {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
      hint(node, { fence: m?.[1] ?? '' });
      break;
    }
    case 'thematicBreak':
      hint(node, { markup: raw });
      break;
    case 'break':
      hint(node, { markup: raw.replace(/\r?\n$/, '') });
      break;
    case 'list': {
      const first = node.children[0];
      const firstRaw = first && slice(first, source);
      if (!firstRaw) break;
      const m = /^([-*+]|(\d{1,9})([.)]))( *)/.exec(firstRaw);
      if (!m) break;
      const markerLen = m[1]?.length ?? 1;
      const spaces = m[4]?.length ?? 1;
      const h: ZyHints = { itemIndent: spaces > 1 && markerLen + spaces === 4 ? 'tab' : 'one' };
      if (node.ordered) {
        h.delimiter = m[3] === ')' ? ')' : '.';
        const second = node.children[1];
        const secondRaw = second && slice(second, source);
        const n2 = secondRaw ? /^(\d{1,9})/.exec(secondRaw)?.[1] : undefined;
        h.increment = n2 === undefined || Number(n2) !== Number(m[2]);
      } else {
        h.bullet = m[1] as '-' | '*' | '+';
      }
      hint(node, h);
      break;
    }
    case 'table': {
      const lines = raw.split(/\r?\n/).map((l) => l.trimEnd());
      const widths = new Set(lines.map((l) => [...l].length));
      hint(node, {
        alignPipes: widths.size === 1 && lines.length > 1,
        cellPadding: !/^\s*\|[^\s|]/.test(lines[0] ?? ''),
        outerPipes: /^\s*\|/.test(lines[0] ?? ''),
        trailingPipe: /\|\s*$/.test(lines[0] ?? ''),
        delimRow: lines[1],
      });
      break;
    }
    case 'link':
      hint(node, { linkKind: raw.startsWith('<') ? 'autolink' : raw.startsWith('[') ? 'inline' : 'literal' });
      break;
  }
}

// ---------- Obsidian 行内语法 & 数学校正 ----------

const OBSIDIAN = /(!?)\[\[([^\[\]\n]+?)\]\]|==(?=\S)([^=\n]*?\S)==|(?<![^\s(（，。；：、])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

function rewriteInline(parent: Parent, source: string) {
  const out: Nodes[] = [];
  let changed = false;
  for (const child of parent.children as Nodes[]) {
    if (child.type === 'text') {
      const parts = splitObsidian(child, source);
      if (parts) {
        out.push(...parts);
        changed = true;
        continue;
      }
    } else if (child.type === 'inlineMath') {
      // 与 Obsidian / Pandoc 一致：$ 内侧不能是空白，例如 "$5 和 $10" 不是公式
      const raw = slice(child, source);
      if (raw && /^\$+\s|\s\$+$/.test(raw)) {
        out.push({ type: 'text', value: raw, position: child.position });
        changed = true;
        continue;
      }
    }
    out.push(child);
  }
  if (changed) parent.children = mergeTexts(out) as typeof parent.children;
}

function splitObsidian(node: Text, source: string): PhrasingContent[] | undefined {
  const { value } = node;
  OBSIDIAN.lastIndex = 0;
  if (!OBSIDIAN.test(value)) return undefined;
  OBSIDIAN.lastIndex = 0;

  // 文本与源码完全一致（没有转义、实体）时才能给新节点算出准确位置
  const start = node.position?.start.offset;
  const exact = start !== undefined && source.slice(start, start + value.length) === value;
  const pos = (from: number, to: number) =>
    exact && start !== undefined
      ? {
          position: {
            start: { line: 0, column: 0, offset: start + from },
            end: { line: 0, column: 0, offset: start + to },
          },
        }
      : {};

  const result: PhrasingContent[] = [];
  let last = 0;
  for (const m of value.matchAll(OBSIDIAN)) {
    const i = m.index;
    if (i > last) result.push({ type: 'text', value: value.slice(last, i), ...pos(last, i) });
    const end = i + m[0].length;
    if (m[2] !== undefined) {
      result.push({ type: 'wikiLink', value: m[2], embed: m[1] === '!', ...pos(i, end) });
    } else if (m[3] !== undefined) {
      result.push({ type: 'highlight', children: [{ type: 'text', value: m[3] }], ...pos(i, end) });
    } else if (m[4] !== undefined) {
      result.push({ type: 'tag', value: m[4], ...pos(i, end) });
    }
    last = end;
  }
  if (last < value.length) result.push({ type: 'text', value: value.slice(last), ...pos(last, value.length) });
  return result;
}

function mergeTexts(nodes: Nodes[]): Nodes[] {
  const out: Nodes[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.type === 'text' && prev?.type === 'text') {
      prev.value += n.value;
      if (prev.position && n.position) prev.position.end = n.position.end;
    } else {
      out.push(n);
    }
  }
  return out;
}
