import type { ZyHints } from '@zyrite/md-blocks';
import type { Definition, Nodes, PhrasingContent, RootContent } from 'mdast';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';

/** mdast → ProseMirror。每个顶层 mdast 节点正好对应一个 ProseMirror 顶层节点。 */
export class FromMdast {
  private readonly defs = new Map<string, Definition>();

  constructor(
    private readonly source: string,
    root: { children: RootContent[] },
  ) {
    collectDefinitions(root as Nodes, this.defs);
  }

  topBlock(node: RootContent, bid: number | null): PMNode {
    const pm = this.block(node, bid) ?? this.raw(node, 'source', bid);
    return pm;
  }

  private raw(node: Nodes, kind: string, bid: number | null): PMNode {
    const s = node.position?.start.offset;
    const e = node.position?.end.offset;
    const text = s !== undefined && e !== undefined ? this.source.slice(s, e) : '';
    return schema.nodes.raw_block!.create({ bid, kind }, text ? schema.text(text) : null);
  }

  private blocks(children: readonly RootContent[]): PMNode[] {
    return children.map((c) => this.block(c, null) ?? this.raw(c, 'source', null));
  }

  private block(node: RootContent, bid: number | null): PMNode | undefined {
    const n = schema.nodes;
    const zy = node.data?.zy ?? {};
    switch (node.type) {
      case 'paragraph':
        return n.paragraph!.create({ bid }, this.inline(node.children, []));
      case 'heading':
        return n.heading!.create(
          { bid, level: node.depth, setext: zy.setext ?? null, markup: zy.markup ?? null },
          this.inline(node.children, []),
        );
      case 'blockquote':
        return n.blockquote!.create({ bid }, this.nonEmpty(this.blocks(node.children)));
      case 'list':
        return n.list!.create(
          {
            bid,
            ordered: !!node.ordered,
            start: node.start ?? 1,
            spread: !!node.spread,
            bullet: zy.bullet ?? null,
            delimiter: zy.delimiter ?? null,
            increment: zy.increment ?? null,
            itemIndent: zy.itemIndent ?? null,
          },
          node.children.map((item) =>
            n.list_item!.create(
              { checked: item.checked ?? null, spread: !!item.spread },
              this.nonEmpty(this.blocks(item.children)),
            ),
          ),
        );
      case 'code':
        return n.code_block!.create(
          { bid, lang: node.lang ?? null, meta: node.meta ?? null, fence: zy.fence ?? null },
          node.value ? schema.text(node.value) : null,
        );
      case 'math':
        return n.math_block!.create({ bid }, node.value ? schema.text(node.value) : null);
      case 'thematicBreak':
        return n.thematic_break!.create({ bid, markup: zy.markup ?? null });
      case 'table': {
        const align = node.align ?? [];
        const rows = node.children.map((row, r) => {
          const cells = row.children.map((cell, c) =>
            (r === 0 ? n.table_header! : n.table_cell!).create(
              { align: align[c] ?? null },
              this.inline(cell.children, []),
            ),
          );
          const raw = row.data?.zy?.raw ?? null;
          return n.table_row!.create({ raw, sig: raw === null ? null : rowSignature(cells) }, cells);
        });
        return n.table!.create(
          {
            bid,
            alignPipes: zy.alignPipes ?? null,
            cellPadding: zy.cellPadding ?? null,
            outerPipes: zy.outerPipes ?? null,
            trailingPipe: zy.trailingPipe ?? null,
            delimRow: zy.delimRow ?? null,
          },
          rows,
        );
      }
      case 'html':
        return this.raw(node, 'html', bid);
      case 'footnoteDefinition':
        return this.raw(node, 'footnote', bid);
      case 'yaml':
        return n.raw_block!.create({ bid, kind: 'yaml' }, node.value ? schema.text(node.value) : null);
      default:
        return undefined;
    }
  }

  private nonEmpty(blocks: PMNode[]): PMNode[] {
    return blocks.length ? blocks : [schema.nodes.paragraph!.create()];
  }

  private inline(children: readonly PhrasingContent[], marks: readonly Mark[]): PMNode[] {
    const out: PMNode[] = [];
    const m = schema.marks;
    const n = schema.nodes;
    for (const c of children) {
      switch (c.type) {
        case 'text':
          if (c.value) out.push(schema.text(c.value, withSrc(c.value, c.data?.zy, marks)));
          break;
        case 'emphasis':
          out.push(...this.inline(c.children, m.em!.create({ marker: c.data?.zy?.marker ?? null }).addToSet(marks)));
          break;
        case 'strong':
          out.push(
            ...this.inline(c.children, m.strong!.create({ marker: c.data?.zy?.marker ?? null }).addToSet(marks)),
          );
          break;
        case 'delete':
          out.push(...this.inline(c.children, m.strike!.create({ marker: c.data?.zy?.strike ?? null }).addToSet(marks)));
          break;
        case 'highlight':
          out.push(...this.inline(c.children, m.highlight!.create().addToSet(marks)));
          break;
        case 'superscript':
          out.push(...this.inline(c.children, m.superscript!.create().addToSet(marks)));
          break;
        case 'subscript':
          out.push(...this.inline(c.children, m.subscript!.create().addToSet(marks)));
          break;
        case 'inlineCode':
          if (c.value) out.push(schema.text(c.value, withSrc(c.value, c.data?.zy, m.code!.create().addToSet(marks))));
          break;
        case 'link':
          out.push(
            ...this.inline(
              c.children,
              m.link!.create({ href: c.url, title: c.title ?? null, kind: c.data?.zy?.linkKind ?? null }).addToSet(
                marks,
              ),
            ),
          );
          break;
        case 'linkReference': {
          const def = this.defs.get(c.identifier);
          const link = m.link!.create({
            href: def?.url ?? '',
            title: def?.title ?? null,
            ref: c.identifier,
            refType: c.referenceType,
            label: c.label ?? null,
          });
          const inner = this.inline(c.children, link.addToSet(marks));
          // [shortcut] 这类没有定义的引用，mdast 里不会出现；有定义时内容可能为空
          out.push(...inner);
          break;
        }
        case 'image':
          out.push(n.image!.create({ src: c.url, alt: c.alt ?? null, title: c.title ?? null }, null, marks));
          break;
        case 'imageReference': {
          const def = this.defs.get(c.identifier);
          out.push(
            n.image!.create(
              {
                src: def?.url ?? '',
                alt: c.alt ?? null,
                title: def?.title ?? null,
                ref: c.identifier,
                refType: c.referenceType,
                label: c.label ?? null,
              },
              null,
              marks,
            ),
          );
          break;
        }
        case 'break':
          out.push(n.hard_break!.create({ markup: c.data?.zy?.markup ?? null }, null, marks));
          break;
        case 'inlineMath':
          out.push(n.inline_math!.create({ value: c.value }, null, marks));
          break;
        case 'wikiLink':
          out.push(n.wikilink!.create({ value: c.value, embed: c.embed }, null, marks));
          break;
        case 'tag':
          out.push(n.tag!.create({ value: c.value }, null, marks));
          break;
        case 'emoji':
          out.push(n.emoji!.create({ value: c.value }, null, marks));
          break;
        case 'footnoteReference':
          out.push(n.footnote_ref!.create({ label: c.label ?? c.identifier }, null, marks));
          break;
        case 'html':
          out.push(n.html_inline!.create({ value: c.value }, null, marks));
          break;
        default: {
          const s = (c as Nodes).position?.start.offset;
          const e = (c as Nodes).position?.end.offset;
          const raw = s !== undefined && e !== undefined ? this.source.slice(s, e) : '';
          if (raw) out.push(schema.text(raw, marks));
        }
      }
    }
    return out;
  }
}

/** 表格行的内容签名：单元格内容和对齐方式 */
export function rowSignature(cells: readonly PMNode[]): string {
  return JSON.stringify(cells.map((c) => [c.attrs.align, c.content.toJSON()]));
}

function withSrc(value: string, zy: ZyHints | undefined, marks: readonly Mark[]): readonly Mark[] {
  if (zy?.raw === undefined) return marks;
  return schema.marks.src!.create({ raw: zy.raw, value, lineStart: !!zy.lineStart }).addToSet(marks);
}

function collectDefinitions(node: Nodes, defs: Map<string, Definition>) {
  if (node.type === 'definition' && !defs.has(node.identifier)) defs.set(node.identifier, node);
  if ('children' in node) for (const c of node.children) collectDefinitions(c as Nodes, defs);
}
