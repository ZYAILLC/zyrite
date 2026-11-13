import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { languages } from '@codemirror/language-data';
import { search } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
  placeholder,
  rectangularSelection,
} from '@codemirror/view';
import {
  anchorAt,
  clipboardFiles,
  codeHighlightStyle,
  defaultLabels,
  type EditorHandle,
  type EditorOptions,
} from '@zyrite/editor-common';
import { blockIndexAt, htmlToMarkdown, splitBlocks } from '@zyrite/md-blocks';
import { annotationField, annotations, setAnnotations } from './annotate';
import { inCode, linkCompletion } from './complete';
import { detectEol, offsetToPos, posToOffset } from './eol';
import { searchAdapter } from './find';
import { focusModePlugin, linksChanged, livePreview } from './preview';
import { zyriteMarkdown } from './syntax';
import { liveTheme } from './theme';

export type LiveOptions = EditorOptions;

/** 粘贴的 HTML 里有排版结构时才转 Markdown；只是带样式的纯文字就按纯文本粘贴 */
const STRUCTURED_HTML = /<(?:p|h[1-6]|ul|ol|li|a|strong|b|em|i|code|pre|table|blockquote|img|del|s)[\s>]/i;

/** 点击位置所在的链接：返回地址和类型 */
function linkAt(state: EditorState, pos: number): { href: string; kind: 'url' | 'wikilink' } | null {
  for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'WikiLink') {
      const src = state.sliceDoc(n.from, n.to);
      const inner = src.slice(src.startsWith('!') ? 3 : 2, -2);
      return { href: inner.split('|')[0] ?? inner, kind: 'wikilink' };
    }
    if (n.name === 'URL' && n.parent?.name !== 'Link' && n.parent?.name !== 'Image') {
      return { href: state.sliceDoc(n.from, n.to), kind: 'url' };
    }
    if (n.name === 'Link' || n.name === 'Autolink') {
      const url = n.getChild('URL');
      return url ? { href: state.sliceDoc(url.from, url.to), kind: 'url' } : null;
    }
  }
  return null;
}

/** 打字机模式：光标始终在垂直居中 */
const typewriterExt: Extension = EditorState.transactionExtender.of((tr) =>
  tr.selection || tr.docChanged
    ? { effects: EditorView.scrollIntoView((tr.selection ?? tr.startState.selection).main.head, { y: 'center' }) }
    : null,
);

/**
 * 纯源码模式的 Markdown 语法高亮。codeHighlightStyle 刻意不映射 Markdown 的标签（实时预览由 livePreview 渲染），
 * 所以纯源码要单独给标题、强调、链接、标记符号上色。
 */
const sourceHighlight: Extension = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading, fontWeight: '600', color: 'var(--z-text)' },
    { tag: tags.strong, fontWeight: '600' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: [tags.link, tags.url], color: 'var(--z-accent)' },
    { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName], color: 'var(--z-muted)' },
    { tag: tags.quote, color: 'var(--z-muted)' },
    { tag: tags.monospace, color: 'var(--z-accent)' },
  ]),
);

export function createLiveEditor(opts: LiveOptions): EditorHandle {
  const rendered = opts.rendered !== false;
  const labels = { ...defaultLabels, ...opts.labels };
  const eol = detectEol(opts.source);
  const focusMode = new Compartment();
  const typewriter = new Compartment();

  const extensions: Extension[] = [
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    closeBrackets(),
    markdownLanguage.data.of({ closeBrackets: { brackets: ['(', '[', '{', '"', '`', '（', '「', '《', '“', '‘'] } }),
    keymap.of([...closeBracketsKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage, codeLanguages: languages, extensions: zyriteMarkdown }),
    syntaxHighlighting(codeHighlightStyle),
    EditorView.lineWrapping,
    search({ createPanel: () => ({ dom: document.createElement('div') }) }),
    rendered ? livePreview({ resolveUrl: opts.resolveUrl, labels, linkStatus: opts.linkStatus }) : sourceHighlight,
    annotations(),
    focusMode.of([]),
    typewriter.of([]),
    liveTheme,
    EditorView.editorAttributes.of({ class: rendered ? 'zy-live-editor' : 'zy-live-editor zy-source-editor' }),
    // 实时预览：#write 沿用 Typora 的正文容器约定，和所见即所得共用 editor-common/content.css 的排版。
    // 纯源码：不用 #write，Typora 主题和正文排版都不作用在源码上，用等宽字体显示原文
    EditorView.contentAttributes.of(
      rendered ? { id: 'write', class: 'zy-doc zy-live', spellcheck: 'false' } : { class: 'zy-source', spellcheck: 'false' },
    ),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange?.();
    }),
    EditorView.domEventHandlers({
      paste(event, view) {
        const data = event.clipboardData;
        if ((!data || !data.types.length) && opts.onPasteEmpty?.()) {
          event.preventDefault();
          return true;
        }
        if (!data || data.types.includes('vscode-editor-data')) return false;
        const pasted = clipboardFiles(data);
        if (pasted.length && opts.onPasteFiles?.(pasted)) {
          event.preventDefault();
          return true;
        }
        const html = data.getData('text/html');
        if (!html || !STRUCTURED_HTML.test(html)) return false;
        if (inCode(view.state, view.state.selection.main.from)) return false;
        const md = htmlToMarkdown(html);
        if (!md) return false;
        event.preventDefault();
        view.dispatch(view.state.replaceSelection(md), { userEvent: 'input.paste', scrollIntoView: true });
        return true;
      },
      mousedown(event, view) {
        if (!opts.onOpenLink || !(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const link = linkAt(view.state, pos);
        if (!link) return false;
        event.preventDefault();
        opts.onOpenLink(link.href, link.kind);
        return true;
      },
    }),
  ];
  if (opts.placeholder) extensions.push(placeholder(opts.placeholder));
  if (opts.completeLinks) extensions.push(linkCompletion(opts.completeLinks));

  const view = new EditorView({
    state: EditorState.create({ doc: opts.source, extensions }),
    parent: opts.parent,
  });

  const getText = () => view.state.doc.sliceString(0, undefined, eol);
  const toPos = (offset: number) => offsetToPos(view.state.doc, offset, eol);

  function moveTo(pos: number, y: 'nearest' | 'start') {
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y, yMargin: 48 }),
    });
    view.focus();
  }

  const find = searchAdapter(view);

  return {
    getText,
    getSelectedText() {
      const { from, to } = view.state.selection.main;
      return view.state.sliceDoc(from, to);
    },
    insertMarkdown(markdown, at) {
      const pos = (at && view.posAtCoords(at)) ?? view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, insert: markdown },
        selection: { anchor: pos + markdown.length },
        userEvent: 'input.drop',
        scrollIntoView: true,
      });
      view.focus();
    },
    getCursorBlock() {
      const { blocks } = splitBlocks(getText());
      if (!blocks.length) return 0;
      return blockIndexAt(blocks, posToOffset(view.state.doc, view.state.selection.main.head, eol));
    },
    setCursorBlock(index) {
      const { blocks } = splitBlocks(getText());
      const block = blocks[Math.min(Math.max(0, index), blocks.length - 1)];
      moveTo(block ? toPos(block.from) : 0, 'nearest');
    },
    revealOffset(offset) {
      moveTo(toPos(offset), 'start');
    },
    focus: () => view.focus(),
    getSelectionInfo() {
      const { from, to } = view.state.selection.main;
      if (from === to) return null;
      const a = view.coordsAtPos(from);
      const b = view.coordsAtPos(to);
      if (!a || !b) return null;
      return {
        ...anchorAt(view.state.doc.toString(), from, to),
        rect: { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) },
      };
    },
    wrapSelection(before, after) {
      const { from, to } = view.state.selection.main;
      if (from === to) return false;
      view.dispatch({
        changes: [
          { from, insert: before },
          { from: to, insert: after },
        ],
        selection: { anchor: from + before.length, head: to + before.length },
        userEvent: 'input.format',
      });
      view.focus();
      return true;
    },
    replaceSelection(text, after) {
      const { from, to } = view.state.selection.main;
      const insert = after ? `${view.state.lineBreak}${view.state.lineBreak}${text}` : text;
      const at = after ? view.state.doc.lineAt(to).to : from;
      view.dispatch({
        changes: { from: at, to: after ? at : to, insert },
        selection: { anchor: at + insert.length },
        userEvent: 'input.ai',
        scrollIntoView: true,
      });
      view.focus();
    },
    setAnnotations(marks) {
      view.dispatch({ effects: setAnnotations.of(marks) });
    },
    annotationTops() {
      const out: Record<string, number> = {};
      for (const [id, [from]] of view.state.field(annotationField).ranges) {
        const c = view.coordsAtPos(from);
        if (c) out[id] = c.top;
      }
      return out;
    },
    revealAnnotation(id) {
      const r = view.state.field(annotationField).ranges.get(id);
      if (r) view.dispatch({ effects: EditorView.scrollIntoView(r[0], { y: 'center' }) });
    },
    focusEnd() {
      view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
      view.focus();
    },
    refreshLinks: () => view.dispatch({ effects: linksChanged.of(null) }),
    setFocusMode(on) {
      view.dispatch({ effects: focusMode.reconfigure(on ? focusModePlugin : []) });
    },
    setTypewriter(on) {
      view.dispatch({ effects: typewriter.reconfigure(on ? typewriterExt : []) });
      if (on) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) });
    },
    lineAt(clientY) {
      const doc = view.state.doc;
      if (!doc.length) return { line: 1, fraction: 0 };
      const height = clientY - view.documentTop;
      const block = view.lineBlockAtHeight(Math.max(0, height));
      const line = doc.lineAt(block.from).number;
      const fraction = block.height > 0 ? Math.min(1, Math.max(0, (height - block.top) / block.height)) : 0;
      return { line, fraction };
    },
    lineRect(line) {
      const doc = view.state.doc;
      if (line < 1 || line > doc.lines) return null;
      const block = view.lineBlockAt(doc.line(line).from);
      return { top: view.documentTop + block.top, height: block.height };
    },
    find,
    destroy: () => view.destroy(),
  };
}
