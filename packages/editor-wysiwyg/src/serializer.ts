import { type BlockDoc, type MdStyle, splitBlocks, stringifyBlock } from '@zyrite/md-blocks';
import type { List } from 'mdast';
import type { Node as PMNode } from 'prosemirror-model';
import { FromMdast } from './from-mdast';
import { schema } from './schema';
import { blockToMdast } from './to-mdast';

interface ItemOrigin {
  list: number;
  index: number;
  text: string;
  sepBefore: string;
}

/**
 * 块级回写（原文保真）。
 *
 * 加载时记下每个顶层块的原文和它前面的分隔（空行），以及对应的 ProseMirror 节点。
 * 序列化时逐个顶层节点：
 * - 和加载时的节点相同（同一对象或结构相等）→ 原样输出原文；
 * - 否则只把这一块重新序列化，沿用原文风格；列表再细一级，只重写改过的列表项；
 * - 块之间的分隔：前后两块在原文里本来就相邻，就用原文的分隔，否则用一个空行。
 * 所以改一个字只会影响那一块，`git diff` 里不会出现别处的变化。
 */
export class BlockSerializer {
  readonly base: BlockDoc;
  readonly doc: PMNode;
  private readonly originals: PMNode[];
  private readonly items = new WeakMap<PMNode, ItemOrigin>();
  private readonly cache = new WeakMap<PMNode, string>();

  constructor(source: string) {
    this.base = splitBlocks(source);
    const conv = new FromMdast(source, this.base.tree);
    this.originals = this.base.blocks.map((b, i) => conv.topBlock(b.node, i));
    this.base.blocks.forEach((b, i) => {
      if (b.node.type === 'list') this.recordItems(i, b.node, this.originals[i]!);
    });
    this.doc = schema.nodes.doc!.create(
      null,
      this.originals.length ? this.originals : [schema.nodes.paragraph!.create()],
    );
  }

  get style(): MdStyle {
    return this.base.style;
  }

  private recordItems(list: number, md: List, pm: PMNode) {
    const src = this.base.source;
    let cursor = md.position?.start.offset ?? 0;
    md.children.forEach((item, index) => {
      const from = item.position?.start.offset;
      const to = item.position?.end.offset;
      if (from === undefined || to === undefined || index >= pm.childCount) return;
      this.items.set(pm.child(index), { list, index, text: src.slice(from, to), sepBefore: src.slice(cursor, from) });
      cursor = to;
    });
  }

  serialize(doc: PMNode): { text: string; ranges: { from: number; to: number }[] } {
    const { blocks, trailing, style } = this.base;
    const eol = style.eol;
    const seen = new Set<number>();
    const ranges: { from: number; to: number }[] = [];
    let out = '';
    // 最近输出的一个原文块；新块后面紧跟的原文块，仍沿用它和这个原文块之间的原分隔
    let lastBid: number | undefined;

    // 原文为空、文档里只有一个空段落：保持为空
    const only = doc.childCount === 1 ? doc.firstChild : null;
    if (!blocks.length && only?.type.name === 'paragraph' && !only.content.size) {
      return { text: this.base.source, ranges: [{ from: 0, to: 0 }] };
    }

    doc.forEach((node, _offset, index) => {
      // 同一个 bid 出现多次（例如段落被拆成两段）时，只有第一次算原文那一块
      let bid = node.attrs.bid as number | null | undefined;
      if (bid === null || bid === undefined || seen.has(bid) || !this.originals[bid]) bid = undefined;
      else seen.add(bid);
      const original = bid !== undefined ? this.originals[bid] : undefined;
      const unchanged = original !== undefined && (original === node || original.eq(node));

      let sep: string;
      if (index === 0) sep = blocks[0]?.sepBefore ?? '';
      else if (bid !== undefined && lastBid === bid - 1) sep = blocks[bid]!.sepBefore;
      else sep = eol + eol;

      const text = unchanged ? blocks[bid!]!.text : this.changed(node, bid);
      out += sep;
      ranges.push({ from: out.length, to: out.length + text.length });
      out += text;
      if (bid !== undefined) lastBid = bid;
    });

    // 末尾换行沿用原文（原文没有末尾换行就不加）；原文为空时按惯例加一个
    out += blocks.length ? trailing : eol;
    return { text: out, ranges };
  }

  /** 诊断用：假设第 index 块被编辑过，按真实路径重写它 */
  rewriteOriginal(index: number): string {
    const node = this.originals[index];
    if (!node) throw new RangeError(`No block at index ${index}`);
    return this.changed(node, index);
  }

  private changed(node: PMNode, bid: number | undefined): string {
    let s = this.cache.get(node);
    if (s === undefined) {
      const original = bid !== undefined ? this.originals[bid] : undefined;
      s =
        node.type.name === 'list' && original?.type === node.type && sameAttrs(original, node)
          ? this.listByItems(node, bid!)
          : stringifyBlock(blockToMdast(node), this.base.style);
      this.cache.set(node, s);
    }
    return s;
  }

  /** 列表改动时逐项回写：没改的项原样输出（编号变了只改编号），改了的项单独重新序列化 */
  private listByItems(list: PMNode, bid: number): string {
    const eol = this.base.style.eol;
    const a = list.attrs;
    const seen = new Set<number>();
    let out = '';
    let prev: number | undefined;
    list.forEach((item, _o, k) => {
      let o = this.items.get(item);
      if (o && (o.list !== bid || seen.has(o.index))) o = undefined;
      if (o) seen.add(o.index);

      const number = a.ordered ? (a.increment === false ? a.start : a.start + k) : undefined;
      let text: string;
      if (o) {
        text = number !== undefined && o.index !== k ? o.text.replace(/^\d+/, String(number)) : o.text;
      } else {
        const single = schema.nodes.list!.create({ ...a, start: number ?? a.start }, [item]);
        text = stringifyBlock(blockToMdast(single), this.base.style);
      }
      const sep = k === 0 ? '' : o && prev === o.index - 1 ? o.sepBefore : a.spread ? eol + eol : eol;
      out += sep + text;
      prev = o?.index;
    });
    return out;
  }
}

function sameAttrs(a: PMNode, b: PMNode): boolean {
  return Object.keys(a.attrs).every((k) => a.attrs[k] === b.attrs[k]);
}
