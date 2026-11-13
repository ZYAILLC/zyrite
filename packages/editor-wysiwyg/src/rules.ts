import {
  baseKeymap,
  chainCommands,
  exitCode,
  joinBackward,
  selectNodeBackward,
  setBlockType,
  toggleMark,
} from 'prosemirror-commands';
import { emojiByName, getParseOptions } from '@zyrite/md-blocks';
import { redo, undo } from 'prosemirror-history';
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { MarkType, Node as PMNode, NodeType } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { type Command, type EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { goToNextCell } from 'prosemirror-tables';
import { arrowIntoCode } from './nodeviews';
import { schema } from './schema';

const n = schema.nodes;
const m = schema.marks;

/** 生成匹配 `<d>text<d>` 的正则，前面不能紧挨着同一个符号 */
function delimited(d: string): RegExp {
  const e = d.replace(/[*^$()[\]{}|\\.+?]/g, '\\$&');
  const c = e[e.length - 1] === '\\' ? e.slice(-2) : e.slice(-1);
  return new RegExp(`(?:^|[^${c}])(${e}([^\\s${c}](?:[^${c}\\n]*[^\\s${c}])?)${e})$`);
}

/** `^x^` 上标、`~x~` 下标：内容不能有空白（Pandoc 规则），`[^` 是脚注写法，不算 */
function tight(d: '^' | '~'): RegExp {
  const e = d === '^' ? '\\^' : d;
  return new RegExp(`(?:^|[^${e}\\[])(${e}([^\\s${e}]+)${e})$`);
}

function inlineMarkRule(d: string, type: MarkType, re = delimited(d), enabled = () => true): InputRule {
  // 注意：触发规则的最后一个字符还没插入文档，[start, end) 只覆盖已有的部分
  return new InputRule(re, (state, match, start, end) => {
    const whole = match[1];
    const text = match[2];
    if (!whole || !text || !enabled()) return null;
    const from = start + match[0].length - whole.length;
    const tr = state.tr.replaceWith(from, end, schema.text(text, [type.create(), ...state.doc.resolve(from).marks()]));
    tr.removeStoredMark(type);
    return tr;
  });
}

/** 行内节点：`$x$` → 公式，`[[x]]` → 双链，`#标签 ` → 标签 */
function inlineNodeRule(re: RegExp, type: NodeType, attrs: (m: RegExpMatchArray) => Record<string, unknown>, keep = ''): InputRule {
  return new InputRule(re, (state, match, start, end) => {
    const whole = match[1] ?? match[0];
    const from = start + match[0].length - whole.length;
    const node = type.create(attrs(match));
    const tr = state.tr.replaceWith(from, end, keep ? [node, schema.text(keep)] : node);
    return tr;
  });
}

export function buildInputRules(): Plugin {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, n.heading!, (match) => ({ level: match[1]!.length })),
      wrappingInputRule(/^\s*>\s$/, n.blockquote!),
      wrappingInputRule(/^\s*[-+*]\s$/, n.list!, { ordered: false }),
      wrappingInputRule(
        /^(\d+)([.)])\s$/,
        n.list!,
        (match) => ({ ordered: true, start: Number(match[1]) }),
        (match, node) => node.childCount + (node.attrs.start as number) === Number(match[1]),
      ),
      // 列表项开头输入 [ ] 或 [x] → 任务
      new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
        const $start = state.doc.resolve(start);
        const item = $start.node(-1);
        if (item?.type !== n.list_item || $start.index(-1) !== 0) return null;
        return state.tr.delete(start, end).setNodeAttribute($start.before(-1), 'checked', match[1] !== ' ');
      }),
      inlineMarkRule('**', m.strong!),
      inlineMarkRule('__', m.strong!),
      inlineMarkRule('*', m.em!),
      inlineMarkRule('_', m.em!),
      inlineMarkRule('~~', m.strike!),
      inlineMarkRule('==', m.highlight!),
      inlineMarkRule('^', m.superscript!, tight('^')),
      // 下标只在设置里打开时生效，否则 `~x~` 是删除线
      inlineMarkRule('~', m.subscript!, tight('~'), () => getParseOptions().subscript),
      inlineMarkRule('`', m.code!),
      // `:rocket:` → 表情；只认 gemoji 里有的名字，冒号前不能紧挨字母数字（`12:30:` 不算）
      new InputRule(/(?:^|[^\p{L}\p{N}])(:([a-z0-9_+-]+):)$/u, (state, match, start, end) => {
        const whole = match[1]!;
        const from = start + match[0].length - whole.length;
        if (emojiByName(match[2]!) === undefined || state.doc.resolve(from).marks().some((mk) => mk.type === m.code)) {
          return null;
        }
        return state.tr.replaceWith(from, end, n.emoji!.create({ value: match[2] }));
      }),
      inlineNodeRule(/(?:^|[^$\\])(\$([^\s$](?:[^$\n]*[^\s$])?)\$)$/, n.inline_math!, (mm) => ({ value: mm[2] })),
      inlineNodeRule(/(!?\[\[([^[\]\n]+)\]\])$/, n.wikilink!, (mm) => ({ value: mm[2], embed: mm[1]!.startsWith('!') })),
      inlineNodeRule(
        /(?:^|\s)(#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)\s)$/u,
        n.tag!,
        (mm) => ({ value: mm[2] }),
        ' ',
      ),
    ],
  });
}

/** 在段落里按回车时的 Markdown 块语法：``` → 代码块，$$ → 公式块，--- → 分隔线 */
const enterBlockSyntax: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== n.paragraph || $from.parentOffset !== $from.parent.content.size) return false;
  const text = $from.parent.textContent;
  const start = $from.before();
  const end = $from.after();
  let fence: RegExpExecArray | null;
  if ((fence = /^(```|~~~)([\w+#.-]*)$/.exec(text))) {
    if (dispatch) {
      const tr = state.tr.replaceWith(start, end, n.code_block!.create({ lang: fence[2] || null }));
      dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)).scrollIntoView());
    }
    return true;
  }
  if (text === '$$') {
    if (dispatch) {
      const tr = state.tr.replaceWith(start, end, n.math_block!.create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)).scrollIntoView());
    }
    return true;
  }
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(text)) {
    if (dispatch) {
      const tr = state.tr.replaceWith(start, end, [n.thematic_break!.create({ markup: text }), n.paragraph!.create()]);
      dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 2)).scrollIntoView());
    }
    return true;
  }
  return false;
};

/** 光标在标题 / 引用开头按退格：先变回普通段落（与 Typora 一致） */
const backspaceToParagraph: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  if ($from.parent.type === n.heading) return setBlockType(n.paragraph!)(state, dispatch);
  return false;
};

const hardBreak: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(n.hard_break!.create()).scrollIntoView());
  return true;
};

const heading =
  (level: number): Command =>
  (state, dispatch) =>
    setBlockType(n.heading!, { level })(state, dispatch);

export function buildKeymaps(): Plugin[] {
  const keys: Record<string, Command> = {
    'Mod-z': undo,
    'Mod-Shift-z': redo,
    'Mod-y': redo,
    Backspace: chainCommands(undoInputRule, backspaceToParagraph, liftEmptyListItem, joinBackward, selectNodeBackward),
    'Mod-b': toggleMark(m.strong!),
    'Mod-i': toggleMark(m.em!),
    'Mod-e': toggleMark(m.code!),
    'Mod-Shift-x': toggleMark(m.strike!),
    'Mod-Shift-h': toggleMark(m.highlight!),
    'Mod-0': setBlockType(n.paragraph!),
    'Mod-1': heading(1),
    'Mod-2': heading(2),
    'Mod-3': heading(3),
    'Mod-4': heading(4),
    'Mod-5': heading(5),
    'Mod-6': heading(6),
    'Shift-Enter': chainCommands(exitCode, hardBreak),
    'Mod-Enter': exitCode,
    Enter: chainCommands(splitListItem(n.list_item!), enterBlockSyntax),
    Tab: chainCommands(goToNextCell(1), sinkListItem(n.list_item!)),
    'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(n.list_item!)),
    ArrowLeft: arrowIntoCode('left'),
    ArrowRight: arrowIntoCode('right'),
    ArrowUp: arrowIntoCode('up'),
    ArrowDown: arrowIntoCode('down'),
  };
  return [keymap(keys), keymap(baseKeymap)];
}

/** 空列表项开头按退格：提升出列表 */
const liftEmptyListItem: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || $from.depth < 2) return false;
  const item = $from.node(-1);
  if (item.type !== n.list_item || $from.index(-1) !== 0) return false;
  return liftListItem(n.list_item!)(state, dispatch);
};

/** 自动配对括号和引号；输入右括号时如果后面正好是它，就跳过去 */
const PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '（': '）',
  '「': '」',
  '《': '》',
  '“': '”',
  '‘': '’',
};
const CLOSERS = new Set(Object.values(PAIRS));

export function autoPair(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        const state: EditorState = view.state;
        if (state.selection.$from.parent.type.spec.code) return false;
        const after = state.doc.textBetween(to, Math.min(to + 1, state.doc.content.size), '\n', '\n');
        if (CLOSERS.has(text) && from === to && after === text) {
          view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, to + 1)));
          return true;
        }
        const close = PAIRS[text];
        if (!close) return false;
        if (from !== to) {
          // 选中文字后输入左括号：包起来
          const tr = state.tr.insertText(close, to).insertText(text, from);
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1)));
          return true;
        }
        if (after && !/[\s)\]}）」》”’.,;:!?，。；：！？]/.test(after)) return false;
        const tr = state.tr.insertText(text + close, from, to);
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1)));
        return true;
      },
    },
  });
}

/** 段落第一个文字是 `[!type]` 的引用块 → callout */
export function calloutType(node: PMNode): string | null {
  if (node.type !== n.blockquote) return null;
  const first = node.firstChild;
  if (!first || first.type !== n.paragraph) return null;
  const mm = /^\[!([\w-]+)\]/.exec(first.textContent);
  return mm?.[1]?.toLowerCase() ?? null;
}

