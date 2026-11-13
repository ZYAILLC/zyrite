import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { forceLinting, lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, search } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { codeHighlightStyle, type EditorHandle, type EditorOptions } from '@zyrite/editor-common';
import { detectEol, offsetToPos } from './eol';
import { searchAdapter } from './find';
import { codeLanguage, lintFormat, logTags } from './languages';
import { formatLinter } from './lint';
import { liveTheme } from './theme';

/**
 * 文本文件编辑器（YAML、JSON、TOML、配置、日志、代码等）：只有源码，没有预览。
 * 行号、折叠、括号匹配、按文件名选语言高亮，JSON/YAML/TOML 有格式校验。
 * 和源码编辑器一样逐字节保存：换行符（LF / CRLF）按打开时的保持。
 */
export interface CodeEditorOptions extends Pick<EditorOptions, 'parent' | 'source' | 'onChange' | 'placeholder'> {
  /** 文件名（用来选语言和校验格式） */
  fileName: string;
  /** 只读：日志、过大的文件 */
  readOnly?: boolean;
}

/** 语言包之外补的颜色：配置文件的键、节标题，日志的级别和时间 */
const extraHighlight = HighlightStyle.define([
  { tag: [tags.propertyName, tags.labelName], color: 'var(--z-syn-def)' },
  { tag: tags.heading, color: 'var(--z-syn-type)', fontWeight: '600' },
  { tag: tags.attributeValue, color: 'var(--z-syn-string)' },
  { tag: logTags.error, color: 'var(--z-review-del-text)', fontWeight: '600' },
  { tag: logTags.warn, color: 'var(--z-syn-number)', fontWeight: '600' },
  { tag: logTags.info, color: 'var(--z-syn-def)' },
  { tag: logTags.debug, color: 'var(--z-muted)' },
  { tag: logTags.time, color: 'var(--z-muted)' },
]);

const codeTheme = EditorView.theme({
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--z-muted)',
    border: 'none',
    // 和正文同字号、同行高，行号和那一行的文字对齐
    fontFamily: 'var(--z-font-mono)',
    fontSize: '13px',
    lineHeight: '1.65',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 12px', minWidth: '28px', opacity: '0.6' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--z-text)' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', cursor: 'pointer' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'transparent',
    border: '1px solid var(--z-hair)',
    borderRadius: '3px',
    color: 'var(--z-muted)',
    padding: '0 4px',
  },
  '.cm-matchingBracket': { backgroundColor: 'var(--z-sel)', outline: 'none' },
  '.cm-selectionMatch': { backgroundColor: 'var(--z-sel)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--z-bg)',
    color: 'var(--z-text)',
    border: '1px solid var(--z-hair)',
    borderRadius: '5px',
  },
  '.cm-diagnostic': { padding: '4px 8px', fontFamily: 'var(--z-font-mono)', fontSize: '12px' },
  '.cm-diagnostic-error': { borderLeft: '2px solid var(--z-review-del-text)' },
});

export function createCodeEditor(opts: CodeEditorOptions): EditorHandle {
  const eol = detectEol(opts.source);
  const language = new Compartment();
  const lang = codeLanguage(opts.fileName);
  const format = lintFormat(opts.fileName);

  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter({ openText: '⌄', closedText: '›' }),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    keymap.of([...closeBracketsKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap, ...foldKeymap, ...lintKeymap]),
    language.of([]),
    syntaxHighlighting(codeHighlightStyle),
    syntaxHighlighting(extraHighlight),
    // 一律折行：编辑区是整页滚动，不折行的话横向滚动条会在文件最底下
    EditorView.lineWrapping,
    search({ createPanel: () => ({ dom: document.createElement('div') }) }),
    liveTheme,
    codeTheme,
    EditorView.editorAttributes.of({ class: 'zy-live-editor zy-textfile-editor' }),
    EditorView.contentAttributes.of({ class: 'zy-source zy-textfile', spellcheck: 'false' }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange?.();
    }),
  ];
  if (format) extensions.push(formatLinter(format));
  if (opts.readOnly) extensions.push(EditorState.readOnly.of(true));
  if (opts.placeholder) extensions.push(placeholder(opts.placeholder));

  const view = new EditorView({
    state: EditorState.create({ doc: opts.source, extensions }),
    parent: opts.parent,
  });

  // 语言包按需加载，加载完再接上（校验依赖语法树定位，重新跑一次）
  let destroyed = false;
  void lang
    .load()
    .then((support) => {
      if (destroyed || !support) return;
      view.dispatch({ effects: language.reconfigure(support) });
      if (format) forceLinting(view);
    })
    .catch(() => {});

  const getText = () => view.state.doc.sliceString(0, undefined, eol);
  const toPos = (offset: number) => offsetToPos(view.state.doc, offset, eol);

  function moveTo(pos: number, y: 'nearest' | 'start' | 'end') {
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y, yMargin: 48 }),
    });
    view.focus();
  }

  return {
    getText,
    getSelectedText() {
      const { from, to } = view.state.selection.main;
      return view.state.sliceDoc(from, to);
    },
    insertMarkdown(text, at) {
      if (view.state.readOnly) return;
      const pos = (at && view.posAtCoords(at)) ?? view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, insert: text },
        selection: { anchor: pos + text.length },
        userEvent: 'input.drop',
        scrollIntoView: true,
      });
      view.focus();
    },
    // 文本文件没有"块"：按行定位（切换文件、重新载入时保持光标所在行）
    getCursorBlock: () => view.state.doc.lineAt(view.state.selection.main.head).number - 1,
    setCursorBlock(index) {
      const doc = view.state.doc;
      moveTo(doc.line(Math.min(Math.max(1, index + 1), doc.lines)).from, 'nearest');
    },
    revealOffset: (offset) => moveTo(toPos(offset), 'start'),
    focus: () => view.focus(),
    focusEnd() {
      view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
      view.focus();
    },
    // 批注、AI 改写、文字颜色只用于 Markdown
    getSelectionInfo: () => null,
    replaceSelection(text) {
      if (view.state.readOnly) return;
      view.dispatch(view.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
    },
    wrapSelection: () => false,
    setAnnotations() {},
    annotationTops: () => ({}),
    revealAnnotation() {},
    refreshLinks() {},
    setFocusMode() {},
    setTypewriter() {},
    find: searchAdapter(view),
    destroy() {
      destroyed = true;
      view.destroy();
    },
  };
}
