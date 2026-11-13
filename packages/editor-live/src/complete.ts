import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, Prec } from '@codemirror/state';
import { type EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { type CompleteLinks, type LinkSuggestion, matchLinkQuery, SuggestMenu } from '@zyrite/editor-common';

const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'CodeText', 'MathBlock', 'InlineMath', 'Frontmatter']);

/** pos 是否在代码、公式、frontmatter 里 */
export function inCode(state: EditorState, pos: number): boolean {
  for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (CODE_NODES.has(n.name)) return true;
  }
  return false;
}

/**
 * 输入 `[[` 后弹出笔记补全。↑↓ 选择，↵ / Tab 插入，Esc 关闭（同一个 `[[` 不再弹出）。
 * 插入时连同自动配对出来的 `]]` 一起处理，光标放到 `]]` 后面。
 */
export function linkCompletion(complete: CompleteLinks): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      menu: SuggestMenu;
      /** 用户按 Esc 关掉的那个 `[[` 的位置 */
      dismissed = -1;
      range: { start: number; from: number; to: number } | null = null;

      constructor(readonly view: EditorView) {
        this.menu = new SuggestMenu((item) => this.pick(item));
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.focusChanged) this.sync();
      }

      sync() {
        const { state } = this.view;
        const sel = state.selection.main;
        if (!sel.empty || !this.view.hasFocus) return this.close();
        const line = state.doc.lineAt(sel.head);
        const m = matchLinkQuery(state.sliceDoc(line.from, sel.head));
        if (!m || inCode(state, sel.head)) return this.close();
        const start = sel.head - m.open;
        if (start === this.dismissed) return this.menu.close();
        this.dismissed = -1;
        this.range = { start, from: sel.head - m.query.length, to: sel.head };
        const items = complete(m.query);
        // 坐标要在测量阶段读
        this.view.requestMeasure({
          read: (v) => v.coordsAtPos(start),
          write: (c) => {
            if (c && this.range?.start === start) this.menu.show(items, c);
          },
        });
      }

      pick(item: LinkSuggestion) {
        const r = this.range;
        if (!r) return;
        const { state } = this.view;
        const after = state.sliceDoc(r.to, r.to + 2);
        const end = after === ']]' ? r.to + 2 : after.startsWith(']') ? r.to + 1 : r.to;
        const insert = `${item.insert}]]`;
        this.view.dispatch({
          changes: { from: r.from, to: end, insert },
          selection: { anchor: r.from + insert.length },
          userEvent: 'input.complete',
        });
        this.close();
        this.view.focus();
      }

      close() {
        this.menu.close();
        this.range = null;
      }

      destroy() {
        this.menu.destroy();
      }
    },
  );

  const keys = Prec.highest(
    keymap.of(
      ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].map((key) => ({
        key,
        run: (v: EditorView) => {
          const p = v.plugin(plugin);
          if (!p?.menu.isOpen) return false;
          if (key === 'Escape') p.dismissed = p.range?.start ?? -1;
          return p.menu.handleKey(key);
        },
      })),
    ),
  );
  return [plugin, keys];
}
