import { type EditorState, type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { type AnnotationMark, locateAnchor } from '@zyrite/editor-common';

/** 批注：对应文字加下划线，后面加上标编号 */

export const setAnnotations = StateEffect.define<AnnotationMark[]>();

interface AnnState {
  marks: AnnotationMark[];
  /** 找到位置的批注：id → [from, to] */
  ranges: Map<string, [number, number]>;
  deco: DecorationSet;
}

class NumberWidget extends WidgetType {
  constructor(readonly n: number) {
    super();
  }
  eq(other: NumberWidget) {
    return other.n === this.n;
  }
  toDOM() {
    const sup = document.createElement('sup');
    sup.className = 'zy-ann-n';
    sup.textContent = String(this.n);
    return sup;
  }
}

function compute(state: EditorState, marks: AnnotationMark[]): AnnState {
  const text = state.doc.toString();
  const ranges = new Map<string, [number, number]>();
  const decos = [];
  for (const m of marks) {
    const r = locateAnchor(text, m.anchor);
    if (!r || r[0] === r[1]) continue;
    ranges.set(m.id, r);
    decos.push(Decoration.mark({ class: m.resolved ? 'zy-ann resolved' : 'zy-ann', attributes: { 'data-ann': m.id } }).range(r[0], r[1]));
    decos.push(Decoration.widget({ widget: new NumberWidget(m.n), side: 1 }).range(r[1]));
  }
  return { marks, ranges, deco: Decoration.set(decos, true) };
}

export const annotationField = StateField.define<AnnState>({
  create: (state) => compute(state, []),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setAnnotations)) return compute(tr.state, e.value);
    return tr.docChanged ? compute(tr.state, value.marks) : value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export function annotations(): Extension {
  return annotationField;
}
