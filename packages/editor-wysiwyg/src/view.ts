import {
  anchorAt,
  type CompleteLinks,
  type EditorHandle,
  type EditorOptions,
  type FindAdapter,
  type FindQuery,
  type LinkSuggestion,
  matchLinkQuery,
  SuggestMenu,
  clipboardFiles,
} from '@zyrite/editor-common';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { history } from 'prosemirror-history';
import { Fragment, type Node as PMNode, Slice } from 'prosemirror-model';
import {
  findNext,
  findPrev,
  getSearchState,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  setSearchState,
} from 'prosemirror-search';
import { EditorState, Plugin, PluginKey, Selection, TextSelection } from 'prosemirror-state';
import { columnResizing, tableEditing } from 'prosemirror-tables';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import {
  CodeView,
  defaultLabels,
  ImageView,
  InlineSourceView,
  ListItemView,
} from './nodeviews';
import { annotationKey, annotationPlugin, flatten } from './annotate';
import { autoPair, buildInputRules, buildKeymaps, calloutType } from './rules';
import { schema } from './schema';
import { extras } from './extras';
import { htmlInline } from './html-inline';
import { BlockSerializer } from './serializer';

export type WysiwygOptions = EditorOptions;

const modesKey = new PluginKey<{ focus: boolean }>('zy-modes');

/** 专注模式（当前块以外变淡）、空文档提示、callout 标记 */
function decorations(placeholder: string | undefined): Plugin<{ focus: boolean }> {
  return new Plugin<{ focus: boolean }>({
    key: modesKey,
    state: {
      init: (): { focus: boolean } => ({ focus: false }),
      apply: (tr, value) => (tr.getMeta(modesKey) as { focus: boolean } | undefined) ?? value,
    },
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        const { doc } = state;
        const focus = modesKey.getState(state)?.focus;
        const current = state.selection.$head.index(0);
        doc.forEach((node, pos, i) => {
          if (focus && i !== current) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'zy-dim' }));
          const callout = calloutType(node);
          if (callout) {
            decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-callout': callout }));
            const mark = /^\[![\w-]+\][-+]?/.exec(node.firstChild!.textContent)?.[0];
            if (mark) decos.push(Decoration.inline(pos + 2, pos + 2 + mark.length, { class: 'callout-mark' }));
          }
        });
        const only = doc.childCount === 1 ? doc.firstChild : null;
        if (placeholder && only && only.type === schema.nodes.paragraph && !only.content.size) {
          decos.push(Decoration.node(0, only.nodeSize, { class: 'placeholder', 'data-placeholder': placeholder }));
        }
        return DecorationSet.create(doc, decos);
      },
    },
  });
}

/** 粘贴：纯文本按 Markdown 解析；从 VS Code 等编辑器复制的代码按纯文本插入；粘贴进来的块不带原文块号 */
function pasteHandling(onPasteFiles?: EditorOptions['onPasteFiles'], onPasteEmpty?: EditorOptions['onPasteEmpty']): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        // 网页读不到剪贴板内容（WebKitGTK 里粘贴图片）：交给应用从系统剪贴板读，不让浏览器自己插入 blob 图片
        paste(_view, event) {
          const data = event.clipboardData;
          if ((!data || !data.types.length) && onPasteEmpty?.()) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
      clipboardTextParser(text, $context) {
        if ($context.parent.type.spec.code) return Slice.empty;
        const doc = new BlockSerializer(text.replace(/\r\n?/g, '\n')).doc;
        return Slice.maxOpen(stripBids(doc.content));
      },
      transformPasted(slice) {
        return new Slice(stripBids(slice.content), slice.openStart, slice.openEnd);
      },
      handlePaste(view, event) {
        const data = event.clipboardData;
        const pasted = clipboardFiles(data ?? null);
        if (pasted.length && onPasteFiles?.(pasted)) return true;
        if (!data?.types.includes('vscode-editor-data')) return false;
        const text = data.getData('text/plain');
        const { $from } = view.state.selection;
        if ($from.parent.type.spec.code) return false;
        const lang = (() => {
          try {
            return (JSON.parse(data.getData('vscode-editor-data')) as { mode?: string }).mode ?? null;
          } catch {
            return null;
          }
        })();
        // 多行代码 → 代码块；单行 → 原样插入文字
        if (text.includes('\n')) {
          const node = schema.nodes.code_block!.create({ lang }, text ? schema.text(text.replace(/\r\n?/g, '\n')) : null);
          view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
        } else {
          view.dispatch(view.state.tr.insertText(text).scrollIntoView());
        }
        return true;
      },
    },
  });
}

function stripBids(fragment: Fragment): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((node) => {
    nodes.push(node.type.spec.attrs?.bid ? node.type.create({ ...node.attrs, bid: null }, node.content, node.marks) : node);
  });
  return Fragment.from(nodes);
}

const linksKey = new PluginKey<DecorationSet>('zy-links');

/** 链接到不存在的笔记的双链加上 missing 类（虚线），库里的笔记变了时重新判断 */
function missingLinks(linkStatus: EditorOptions['linkStatus']): Plugin<DecorationSet> {
  // 库里的文件变了（refreshLinks）时加一，嵌入（`![[…]]`）的装饰跟着变，节点视图会重新解析、重画
  let version = 0;
  const build = (doc: PMNode) => {
    const decos: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (node.type !== schema.nodes.wikilink) return true;
      if (node.attrs.embed) {
        decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-embed-version': String(version) }));
        return false;
      }
      const target = (String(node.attrs.value).split(/[|#]/)[0] ?? '').trim();
      if (linkStatus?.(target) === 'missing') decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'missing' }));
      return false;
    });
    return DecorationSet.create(doc, decos);
  };
  return new Plugin<DecorationSet>({
    key: linksKey,
    state: {
      init: (_, state) => build(state.doc),
      apply: (tr, value) => {
        if (tr.getMeta(linksKey)) version++;
        return tr.docChanged || tr.getMeta(linksKey) ? build(tr.doc) : value;
      },
    },
    props: { decorations: (state) => linksKey.getState(state) },
  });
}

/**
 * 输入 `[[` 后弹出笔记补全，和实时预览共用菜单。选中后直接插入双链节点，
 * 连同自动配对出来的 `]]` 一起替换。Esc 关闭后同一个 `[[` 不再弹出。
 */
function linkCompletion(complete: CompleteLinks): Plugin {
  let menu: SuggestMenu | null = null;
  let range: { start: number; to: number } | null = null;
  let dismissed = -1;

  const close = () => {
    menu?.close();
    range = null;
  };

  const pick = (view: EditorView, item: LinkSuggestion) => {
    const r = range;
    if (!r) return;
    const { state } = view;
    const $to = state.doc.resolve(r.to);
    const after = state.doc.textBetween(r.to, Math.min(r.to + 2, $to.end()), undefined, '\ufffc');
    const end = after === ']]' ? r.to + 2 : after.startsWith(']') ? r.to + 1 : r.to;
    const embed = state.doc.textBetween(r.start, r.start + 1) === '!';
    const node = schema.nodes.wikilink!.create({ value: item.insert, embed });
    const tr = state.tr.replaceWith(r.start, end, node);
    tr.setSelection(Selection.near(tr.doc.resolve(r.start + node.nodeSize)));
    view.dispatch(tr.scrollIntoView());
    close();
    view.focus();
  };

  const sync = (view: EditorView) => {
    const sel = view.state.selection;
    if (!sel.empty || !view.hasFocus()) return close();
    const { $from } = sel;
    if ($from.parent.type.spec.code || !$from.parent.isTextblock) return close();
    const offset = $from.parentOffset;
    const before = $from.parent.textBetween(Math.max(0, offset - 200), offset, undefined, '\ufffc');
    const m = matchLinkQuery(before);
    if (!m) return close();
    const start = $from.pos - m.open;
    if (start === dismissed) return menu?.close();
    dismissed = -1;
    range = { start, to: $from.pos };
    menu?.show(complete(m.query), view.coordsAtPos(start));
  };

  return new Plugin({
    view(view) {
      menu = new SuggestMenu((item) => pick(view, item));
      return {
        update: (v) => sync(v),
        destroy: () => menu?.destroy(),
      };
    },
    props: {
      handleKeyDown(_view, e) {
        if (!menu?.isOpen || e.isComposing) return false;
        if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return false;
        if (e.key === 'Escape') dismissed = range?.start ?? -1;
        return menu.handleKey(e.key);
      },
      handleDOMEvents: {
        blur: () => {
          close();
          return false;
        },
      },
    },
  });
}

/** ⌘/Ctrl + 点击链接打开 */
function links(onOpenLink: EditorOptions['onOpenLink']): Plugin {
  return new Plugin({
    props: {
      handleClick(view, pos, event) {
        if (!onOpenLink || !(event.metaKey || event.ctrlKey)) return false;
        const link = view.state.doc.resolve(pos).marks().find((m) => m.type === schema.marks.link);
        if (!link) return false;
        onOpenLink(String(link.attrs.href), 'url');
        return true;
      },
    },
  });
}

/** 找到最近的可滚动祖先 */
function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return document.scrollingElement as HTMLElement;
}

export function createWysiwygEditor(opts: WysiwygOptions): EditorHandle {
  const labels = { ...defaultLabels, ...opts.labels };
  const serializer = new BlockSerializer(opts.source);
  let typewriter = false;

  const dom = document.createElement('div');
  opts.parent.append(dom);

  const view: EditorView = new EditorView(
    { mount: dom },
    {
      state: EditorState.create({
        doc: serializer.doc,
        plugins: [
          // 补全菜单打开时要先于快捷键处理 ↵ / ↑↓ / Esc，所以放在最前面
          ...(opts.completeLinks ? [linkCompletion(opts.completeLinks)] : []),
          buildInputRules(),
          ...buildKeymaps(),
          autoPair(),
          history(),
          dropCursor({ color: 'var(--z-accent)', width: 2 }),
          gapCursor(),
          columnResizing(),
          tableEditing(),
          search(),
          decorations(opts.placeholder),
          pasteHandling(opts.onPasteFiles, opts.onPasteEmpty),
          links(opts.onOpenLink),
          missingLinks(opts.linkStatus),
          htmlInline(),
          extras(),
          annotationPlugin(),
        ],
      }),
      attributes: { id: 'write', class: 'zy-doc zy-wysiwyg', spellcheck: 'false' },
      nodeViews: {
        code_block: (node, v, getPos) => new CodeView(node, v, getPos, labels),
        math_block: (node, v, getPos) => new CodeView(node, v, getPos, labels),
        raw_block: (node, v, getPos) => new CodeView(node, v, getPos, labels, opts.resolveUrl, opts.onOpenLink),
        inline_math: (node, v, getPos) => new InlineSourceView(node, v, getPos, opts.onOpenLink),
        wikilink: (node, v, getPos) => new InlineSourceView(node, v, getPos, opts.onOpenLink, opts.resolveEmbed, opts.resolveUrl),
        tag: (node, v, getPos) => new InlineSourceView(node, v, getPos, opts.onOpenLink),
        emoji: (node, v, getPos) => new InlineSourceView(node, v, getPos),
        html_inline: (node, v, getPos) => new InlineSourceView(node, v, getPos, opts.onOpenLink, undefined, opts.resolveUrl),
        footnote_ref: (node, v, getPos) => new InlineSourceView(node, v, getPos, opts.onOpenLink),
        list_item: (node, v, getPos) => new ListItemView(node, v, getPos),
        image: (node) => new ImageView(node, opts.resolveUrl),
      },
      handleScrollToSelection(v) {
        if (!typewriter) return false;
        centerCursor(v);
        return true;
      },
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        if (tr.docChanged) opts.onChange?.();
      },
    },
  );

  function centerCursor(v: EditorView) {
    const scroller = scrollParent(v.dom);
    const coords = v.coordsAtPos(v.state.selection.head);
    const box = scroller.getBoundingClientRect();
    scroller.scrollTop += coords.top - (box.top + box.height / 2);
  }

  function blockStart(index: number): number {
    const doc = view.state.doc;
    let pos = 0;
    for (let i = 0; i < Math.min(index, doc.childCount - 1); i++) pos += doc.child(i).nodeSize;
    return pos;
  }

  function setCursorBlock(index: number) {
    const pos = blockStart(Math.max(0, index));
    const sel = Selection.near(view.state.doc.resolve(Math.min(pos + 1, view.state.doc.content.size)));
    view.dispatch(view.state.tr.setSelection(sel));
    view.focus();
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: typewriter ? 'center' : 'nearest' });
  }

  // ---------- 查找替换 ----------
  let query = new SearchQuery({ search: '' });

  function stats(): { count: number; current: number } {
    const state = view.state;
    const q = getSearchState(state)?.query;
    if (!q?.valid) return { count: 0, current: 0 };
    let count = 0;
    let current = 0;
    const { from, to } = state.selection;
    let pos = 0;
    for (let r = q.findNext(state, pos); r && count < 10000; r = q.findNext(state, pos)) {
      count++;
      if (r.from === from && r.to === to) current = count;
      pos = r.to > r.from ? r.to : r.to + 1;
      if (pos > state.doc.content.size) break;
    }
    return { count, current };
  }

  const find: FindAdapter = {
    setQuery(q: FindQuery) {
      query = new SearchQuery({ search: q.search, replace: q.replace, caseSensitive: q.caseSensitive, regexp: q.regexp });
      view.dispatch(setSearchState(view.state.tr, query));
      return stats();
    },
    next() {
      findNext(view.state, view.dispatch);
      return stats();
    },
    prev() {
      findPrev(view.state, view.dispatch);
      return stats();
    },
    replace() {
      replaceNext(view.state, view.dispatch);
      return stats();
    },
    replaceAll() {
      const before = stats().count;
      replaceAll(view.state, view.dispatch);
      return before;
    },
    close() {
      view.dispatch(setSearchState(view.state.tr, new SearchQuery({ search: '' })));
      view.focus();
    },
  };

  return {
    getText: () => serializer.serialize(view.state.doc).text,
    getSelectedText() {
      const { from, to } = view.state.selection;
      return view.state.doc.textBetween(from, to, '\n', ' ');
    },
    insertMarkdown(markdown, at) {
      const pos = (at && view.posAtCoords({ left: at.x, top: at.y })?.pos) ?? view.state.selection.from;
      const $pos = view.state.doc.resolve(pos);
      const tr = view.state.tr;
      if ($pos.parent.type.spec.code) tr.insertText(markdown, pos);
      else tr.replaceRange(pos, pos, Slice.maxOpen(stripBids(new BlockSerializer(markdown).doc.content)));
      // 光标放到插入内容之后
      const end = tr.mapping.map(pos, 1);
      tr.setSelection(Selection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1));
      view.dispatch(tr.scrollIntoView());
      view.focus();
    },
    getCursorBlock: () => view.state.selection.$head.index(0),
    setCursorBlock,
    revealOffset(offset) {
      const { ranges } = serializer.serialize(view.state.doc);
      let index = ranges.findIndex((r) => offset <= r.to);
      if (index < 0) index = ranges.length - 1;
      setCursorBlock(index);
    },
    focus: () => view.focus(),
    getSelectionInfo() {
      const { from, to } = view.state.selection;
      if (from === to) return null;
      const flat = flatten(view.state.doc);
      const a = view.coordsAtPos(from);
      const b = view.coordsAtPos(to);
      return {
        ...anchorAt(flat.text, flat.toOffset(from), flat.toOffset(to)),
        rect: { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) },
      };
    },
    wrapSelection(before, after) {
      const { state } = view;
      const { from, to, $from, $to } = state.selection;
      // 行内 HTML 只能放在同一个段落（标题、表格单元格）里
      if (from === to || $from.parent !== $to.parent || !$from.parent.inlineContent || $from.parent.type.spec.code) return false;
      const html = schema.nodes.html_inline!;
      // 标签带上两端文字的格式（粗体、链接等），写回去是 `**<span>粗</span>**` 而不是把格式拆开
      const startMarks = state.doc.nodeAt(from)?.marks;
      const endMarks = state.doc.nodeAt(to - 1)?.marks;
      const tr = state.tr
        .insert(to, html.create({ value: after }, null, endMarks))
        .insert(from, html.create({ value: before }, null, startMarks));
      tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1));
      view.dispatch(tr.scrollIntoView());
      view.focus();
      return true;
    },
    replaceSelection(markdown, after) {
      const { state } = view;
      const { from, to, $to } = state.selection;
      const content = stripBids(new BlockSerializer(markdown).doc.content);
      const tr = state.tr;
      // after：插到选区所在的顶层块后面；否则替换选中的部分
      if (after) tr.insert($to.depth > 0 ? $to.after(1) : to, content);
      else tr.replaceRange(from, to, Slice.maxOpen(content));
      view.dispatch(tr.scrollIntoView());
      view.focus();
    },
    setAnnotations(marks) {
      view.dispatch(view.state.tr.setMeta(annotationKey, marks));
    },
    annotationTops() {
      const out: Record<string, number> = {};
      for (const [id, [from]] of annotationKey.getState(view.state)?.ranges ?? []) {
        try {
          out[id] = view.coordsAtPos(from).top;
        } catch {
          // 位置不在视图里
        }
      }
      return out;
    },
    revealAnnotation(id) {
      const r = annotationKey.getState(view.state)?.ranges.get(id);
      if (!r) return;
      const dom = view.domAtPos(r[0]).node;
      (dom instanceof HTMLElement ? dom : dom.parentElement)?.scrollIntoView({ block: 'center' });
    },
    focusEnd() {
      view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)).scrollIntoView());
      view.focus();
    },
    refreshLinks: () => view.dispatch(view.state.tr.setMeta(linksKey, true)),
    setFocusMode(on) {
      view.dispatch(view.state.tr.setMeta(modesKey, { focus: on }));
    },
    setTypewriter(on) {
      typewriter = on;
      if (on) centerCursor(view);
    },
    find,
    destroy() {
      view.destroy();
      dom.remove();
    },
  };
}

