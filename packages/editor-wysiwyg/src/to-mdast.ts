import type { AlignType, BlockContent, ListItem, PhrasingContent, RootContent, TableRow } from 'mdast';
import type { ZyHints } from '@zyrite/md-blocks';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { rowSignature } from './from-mdast';

/** ProseMirror → mdast，只在块被编辑过、需要重新序列化时用 */

const hints = (h: ZyHints) => {
  const clean = Object.fromEntries(Object.entries(h).filter(([, v]) => v !== null && v !== undefined));
  return Object.keys(clean).length ? { data: { zy: clean as ZyHints } } : {};
};

export function blockToMdast(node: PMNode): RootContent {
  const a = node.attrs;
  switch (node.type.name) {
    case 'paragraph':
      return { type: 'paragraph', children: inlineToMdast(node) };
    case 'heading':
      return {
        type: 'heading',
        depth: a.level,
        children: inlineToMdast(node),
        ...hints({ setext: a.setext, markup: a.markup }),
      };
    case 'blockquote': {
      const kids = children(node) as BlockContent[];
      // Obsidian callout 的 `[!note]` 标记原样输出，否则 `[` 会被转义
      const first = kids[0]?.type === 'paragraph' ? kids[0].children[0] : undefined;
      if (first?.type === 'text') {
        const m = /^\[![\w-]+\][-+]?/.exec(first.value);
        if (m && kids[0]?.type === 'paragraph') {
          kids[0].children.splice(0, 1, { type: 'zyRaw', value: m[0] }, { type: 'text', value: first.value.slice(m[0].length) });
        }
      }
      return { type: 'blockquote', children: kids };
    }
    case 'list': {
      const items: ListItem[] = [];
      node.forEach((item) => {
        items.push({
          type: 'listItem',
          spread: !!item.attrs.spread,
          checked: item.attrs.checked,
          children: children(item) as BlockContent[],
        });
      });
      return {
        type: 'list',
        ordered: !!a.ordered,
        start: a.ordered ? a.start : null,
        spread: !!a.spread,
        children: items,
        ...hints({ bullet: a.bullet, delimiter: a.delimiter, increment: a.increment, itemIndent: a.itemIndent }),
      };
    }
    case 'code_block':
      return { type: 'code', lang: a.lang, meta: a.meta, value: node.textContent, ...hints({ fence: a.fence }) };
    case 'math_block':
      return { type: 'math', value: node.textContent };
    case 'thematic_break':
      return { type: 'thematicBreak', ...hints({ markup: a.markup }) };
    case 'table': {
      const rows: TableRow[] = [];
      const align: AlignType[] = [];
      node.forEach((row, _o, r) => {
        const cells: TableRow['children'] = [];
        const pm: PMNode[] = [];
        row.forEach((cell) => {
          if (r === 0) align.push((cell.attrs.align as AlignType) ?? null);
          cells.push({ type: 'tableCell', children: inlineToMdast(cell) });
          pm.push(cell);
        });
        const same = row.attrs.raw !== null && row.attrs.sig === rowSignature(pm);
        rows.push({ type: 'tableRow', children: cells, ...(same ? hints({ raw: row.attrs.raw }) : {}) });
      });
      return {
        type: 'table',
        align,
        children: rows,
        ...hints({
          alignPipes: a.alignPipes,
          cellPadding: a.cellPadding,
          outerPipes: a.outerPipes,
          trailingPipe: a.trailingPipe,
          delimRow: a.delimRow,
        }),
      };
    }
    case 'raw_block':
      if (a.kind === 'yaml') return { type: 'yaml', value: node.textContent };
      // html 处理器原样输出 value，正好用来输出源码块
      return { type: 'html', value: node.textContent };
    default:
      return { type: 'html', value: node.textContent };
  }
}

function children(node: PMNode): RootContent[] {
  const out: RootContent[] = [];
  node.forEach((c) => out.push(blockToMdast(c)));
  return out;
}

type Parent = { children: PhrasingContent[] };

function markToMdast(mark: Mark): (PhrasingContent & Parent) | undefined {
  const a = mark.attrs;
  switch (mark.type.name) {
    case 'em':
      return { type: 'emphasis', children: [], ...hints({ marker: a.marker }) };
    case 'strong':
      return { type: 'strong', children: [], ...hints({ marker: a.marker }) };
    case 'strike':
      return { type: 'delete', children: [], ...hints({ strike: a.marker }) };
    case 'highlight':
      return { type: 'highlight', children: [] };
    case 'superscript':
      return { type: 'superscript', children: [] };
    case 'subscript':
      return { type: 'subscript', children: [] };
    case 'link':
      if (a.ref) {
        return {
          type: 'linkReference',
          identifier: a.ref,
          label: a.label ?? a.ref,
          referenceType: a.refType ?? 'full',
          children: [],
        };
      }
      return { type: 'link', url: a.href, title: a.title, children: [], ...hints({ linkKind: a.kind }) };
    default:
      return undefined;
  }
}

function leafToMdast(node: PMNode, lineStart: boolean): PhrasingContent | undefined {
  const a = node.attrs;
  switch (node.type.name) {
    case 'text': {
      const text = node.text ?? '';
      // 文字没改过，并且不会因为挪到行首而改变含义 → 原样输出原文
      const src = node.marks.find((m) => m.type.name === 'src');
      if (src && src.attrs.value === text && (!lineStart || src.attrs.lineStart)) {
        return { type: 'zyRaw', value: src.attrs.raw as string };
      }
      return node.marks.some((m) => m.type.name === 'code')
        ? { type: 'inlineCode', value: text }
        : { type: 'text', value: text };
    }
    case 'image':
      if (a.ref) {
        return {
          type: 'imageReference',
          identifier: a.ref,
          label: a.label ?? a.ref,
          referenceType: a.refType ?? 'full',
          alt: a.alt,
        };
      }
      return { type: 'image', url: a.src, alt: a.alt, title: a.title };
    case 'hard_break':
      return { type: 'break', ...hints({ markup: a.markup }) };
    case 'inline_math':
      return { type: 'inlineMath', value: a.value };
    case 'wikilink':
      return { type: 'wikiLink', value: a.value, embed: !!a.embed };
    case 'tag':
      return { type: 'tag', value: a.value };
    case 'emoji':
      return { type: 'emoji', value: a.value };
    case 'footnote_ref':
      return { type: 'footnoteReference', identifier: String(a.label).toLowerCase(), label: a.label };
    case 'html_inline':
      return { type: 'html', value: a.value };
    default:
      return undefined;
  }
}

/** 行内内容：按 ProseMirror 的扁平 marks 重新嵌套成 mdast 树 */
export function inlineToMdast(node: PMNode): PhrasingContent[] {
  const root: Parent = { children: [] };
  const stack: { mark: Mark; parent: Parent }[] = [];
  let prev: PMNode | undefined;
  node.forEach((child) => {
    const lineStart = !prev || prev.type.name === 'hard_break';
    prev = child;
    const marks = child.marks.filter((m) => m.type.name !== 'code' && m.type.name !== 'src');
    let keep = 0;
    while (keep < stack.length && keep < marks.length && stack[keep]!.mark.eq(marks[keep]!)) keep++;
    stack.length = keep;
    for (let i = keep; i < marks.length; i++) {
      const parent = stack.length ? stack[stack.length - 1]!.parent : root;
      const m = markToMdast(marks[i]!);
      if (!m) continue;
      parent.children.push(m);
      stack.push({ mark: marks[i]!, parent: m });
    }
    const leaf = leafToMdast(child, lineStart);
    if (leaf) (stack.length ? stack[stack.length - 1]!.parent : root).children.push(leaf);
  });
  return root.children;
}
