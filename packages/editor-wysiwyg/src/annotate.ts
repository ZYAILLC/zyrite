import { type AnnotationMark, locateAnchor } from '@zyrite/editor-common';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

/**
 * 所见即所得里的批注和选区：ProseMirror 的文档不是原文，先摊平成纯文字（块之间用换行），
 * 在纯文字里按"片段 + 前后文"定位，再换算回文档位置。
 */

interface Segment {
  offset: number;
  pos: number;
  len: number;
}

export interface FlatText {
  text: string;
  toPos(offset: number): number;
  toOffset(pos: number): number;
}

export function flatten(doc: PMNode): FlatText {
  let text = '';
  const segs: Segment[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      segs.push({ offset: text.length, pos, len: node.text!.length });
      text += node.text;
    } else if (node.isBlock) {
      if (text && !text.endsWith('\n')) text += '\n';
    } else if (node.isLeaf) {
      text += '￼'; // 行内的公式、双链等占一个字符
    }
    return true;
  });
  return {
    text,
    toPos(offset) {
      for (const s of segs) if (offset >= s.offset && offset <= s.offset + s.len) return s.pos + (offset - s.offset);
      const next = segs.find((s) => s.offset > offset);
      return next ? next.pos : doc.content.size;
    },
    toOffset(pos) {
      for (const s of segs) if (pos >= s.pos && pos <= s.pos + s.len) return s.offset + (pos - s.pos);
      const next = segs.find((s) => s.pos > pos);
      return next ? next.offset : text.length;
    },
  };
}

interface AnnState {
  marks: AnnotationMark[];
  ranges: Map<string, [number, number]>;
  deco: DecorationSet;
}

export const annotationKey = new PluginKey<AnnState>('zy-annotations');

function build(doc: PMNode, marks: AnnotationMark[]): AnnState {
  const flat = flatten(doc);
  const ranges = new Map<string, [number, number]>();
  const decos: Decoration[] = [];
  for (const m of marks) {
    const r = locateAnchor(flat.text, m.anchor);
    if (!r) continue;
    const from = flat.toPos(r[0]);
    const to = flat.toPos(r[1]);
    if (from >= to) continue;
    ranges.set(m.id, [from, to]);
    decos.push(Decoration.inline(from, to, { class: m.resolved ? 'zy-ann resolved' : 'zy-ann', 'data-ann': m.id }));
    decos.push(
      Decoration.widget(
        to,
        () => {
          const sup = document.createElement('sup');
          sup.className = 'zy-ann-n';
          sup.textContent = String(m.n);
          return sup;
        },
        { side: 1, key: `ann-${m.id}-${m.n}` },
      ),
    );
  }
  return { marks, ranges, deco: DecorationSet.create(doc, decos) };
}

export function annotationPlugin(): Plugin<AnnState> {
  return new Plugin<AnnState>({
    key: annotationKey,
    state: {
      init: (_, state) => build(state.doc, []),
      apply(tr, value) {
        const marks = tr.getMeta(annotationKey) as AnnotationMark[] | undefined;
        if (marks) return build(tr.doc, marks);
        return tr.docChanged ? build(tr.doc, value.marks) : value;
      },
    },
    props: { decorations: (state) => annotationKey.getState(state)?.deco },
  });
}
