import { syntaxTree } from '@codemirror/language';
import { type EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * "当前块"：实时预览里显示 Markdown 标记的区域。
 * - 光标在段落、标题、表格、代码块、公式块等顶层块里：整块显示标记
 * - 光标在列表、引用里：只有光标所在的行显示标记，长列表不会整片露出符号
 * - 编辑器没有焦点时全部渲染，方便阅读
 */

export const setFocused = StateEffect.define<boolean>();

export const focusedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocused)) value = e.value;
    return value;
  },
  provide: () => EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
});

export interface Span {
  from: number;
  to: number;
}

const CONTAINERS = new Set(['BulletList', 'OrderedList', 'Blockquote']);

export function activeRanges(state: EditorState): Span[] {
  if (!state.field(focusedField, false)) return [];
  const top = syntaxTree(state).topNode;
  const out: Span[] = [];
  for (const r of state.selection.ranges) {
    let from = state.doc.lineAt(r.from).from;
    let to = state.doc.lineAt(r.to).to;
    for (let node = top.firstChild; node; node = node.nextSibling) {
      if (node.to < r.from) continue;
      if (node.from > r.to) break;
      if (!CONTAINERS.has(node.name)) {
        from = Math.min(from, node.from);
        to = Math.max(to, node.to);
      }
    }
    out.push({ from, to });
  }
  return out;
}

/** 区间 [from, to] 是否碰到当前块（端点相接也算） */
export function touches(spans: readonly Span[], from: number, to: number): boolean {
  return spans.some((s) => s.from <= to && from <= s.to);
}

/** 主光标所在的顶层块（专注模式用）；不在任何块里时取光标所在行 */
export function currentBlock(state: EditorState): Span {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.from > head) break;
    if (node.to >= head) {
      // 列表、引用按行
      return CONTAINERS.has(node.name) ? { from: line.from, to: line.to } : { from: node.from, to: node.to };
    }
  }
  return { from: line.from, to: line.to };
}
