import { buildToc, colorSwatch, cssColor, isTocMarker, type TocHeading } from '@zyrite/editor-common';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { schema } from './schema';

/**
 * 所见即所得里的两个小渲染：
 * - 行内代码是颜色值（`#E0A040`）时，后面加一个色块
 * - 单独一段 `[TOC]`：段落本身变成一行淡色的小字（还能编辑），上面显示全文的标题目录，点击跳到标题
 */

const key = new PluginKey<DecorationSet>('zy-extras');

function headingsOf(doc: PMNode): { list: TocHeading[]; pos: number[] } {
  const list: TocHeading[] = [];
  const pos: number[] = [];
  doc.descendants((node, p) => {
    if (node.type === schema.nodes.heading) {
      list.push({ level: Number(node.attrs.level), text: node.textContent.trim() });
      pos.push(p);
      return false;
    }
    // 标题只在顶层和引用、列表里；代码块等不用往里找
    return !node.isTextblock;
  });
  return { list, pos };
}

function build(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  const code = schema.marks.code;
  let toc: ReturnType<typeof headingsOf> | null = null;
  doc.descendants((node, pos) => {
    if (node.isText) {
      if (code && code.isInSet(node.marks)) {
        const color = cssColor(node.text ?? '');
        if (color) decos.push(Decoration.widget(pos + node.nodeSize, () => colorSwatch(color), { side: -1, key: `sw:${color}` }));
      }
      return false;
    }
    if (node.type === schema.nodes.paragraph && isTocMarker(node.textContent) && node.childCount <= 1) {
      toc ??= headingsOf(doc);
      const { list } = toc;
      const sig = list.map((h) => `${h.level}${h.text}`).join('\u0001');
      decos.push(
        Decoration.widget(
          pos,
          (view: EditorView) => {
            const nav = buildToc(list);
            nav.addEventListener('mousedown', (e) => {
              const link = (e.target as HTMLElement).closest<HTMLElement>('a.zy-toc-link');
              if (!link) return;
              e.preventDefault();
              // 目录元素会被复用（标题没变时），位置要按当前文档重新算
              const at = headingsOf(view.state.doc).pos[Number(link.dataset.index)];
              if (at === undefined) return;
              const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at + 1)));
              view.dispatch(tr.scrollIntoView());
              view.focus();
            });
            nav.addEventListener('click', (e) => e.preventDefault());
            return nav;
          },
          { side: -1, key: `toc:${sig}`, ignoreSelection: true, stopEvent: () => true },
        ),
      );
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'zy-toc-marker' }));
      return false;
    }
    return true;
  });
  return DecorationSet.create(doc, decos);
}

export function extras(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => build(state.doc),
      apply: (tr, value) => (tr.docChanged ? build(tr.doc) : value),
    },
    props: { decorations: (state) => key.getState(state) },
  });
}
