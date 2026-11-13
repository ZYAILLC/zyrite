import { EditorView } from '@codemirror/view';

/** CodeMirror 自带样式的覆盖（优先级高于它的 baseTheme）；正文排版见 live.css */
export const liveTheme = EditorView.theme({
  '&': { minHeight: '100%', backgroundColor: 'transparent', color: 'var(--z-text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'visible' },
  '.cm-content': { caretColor: 'var(--z-text)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--z-text)', borderLeftWidth: '1.5px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--z-sel)' },
  // 查找替换用应用自己的查找栏，CodeMirror 的搜索面板只用来承载状态，不显示
  '.cm-panels': { display: 'none' },
});
