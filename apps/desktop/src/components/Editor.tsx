import type { EditorOptions } from '@zyrite/editor-common';
import { createCodeEditor, createLiveEditor } from '@zyrite/editor-live';
import { createWysiwygEditor } from '@zyrite/editor-wysiwyg';
import { type MouseEvent as ReactMouseEvent, useEffect, useRef } from 'react';
import { t } from '../i18n';
import { backend } from '../lib/backend';
import { noteEdit, openLink } from '../lib/document';
import { resolveEmbed } from '../lib/embeds';
import { completeLinks, linkStatus, openWikiLink } from '../lib/linkIndex';
import { activeEditor, setActiveEditor } from '../lib/editorRef';
import { pasteFromSystem, pasteImages } from '../lib/images';
import { basename, LOG_FILE } from '../lib/paths';
import { editorKind, useApp } from '../store';

/** 编辑后多久把内容同步到 store（字数、大纲、是否有未保存修改） */
const SYNC_DELAY = 250;

interface Carry {
  docId: number;
  text: string;
  /** 切换前光标所在的顶层块；切换前编辑器没有焦点时不恢复光标 */
  block?: number;
  scrollTop: number;
  /** 关掉前滚到了最底下（日志重新载入后继续跟到末尾） */
  atEnd?: boolean;
}

/**
 * 编辑区。
 * - 编辑器种类由原文、预览开关决定（store 的 editorKind）：分栏时原文是纯源码，只开原文时按设置用纯源码或实时预览，
 *   只开预览时是所见即所得。
 * - 换种类：取出全文和光标所在块，销毁旧编辑器，用同一份全文建新编辑器，
 *   光标放回同一块，滚动位置尽量保持。所见即所得做块级回写，切换本身不会改动原文。
 * - 换文档（打开、新建、还原，docId 变化）：用 store 里的新内容重建，光标和滚动回到开头。
 * - 改了影响解析的设置（下标写法）：和换种类一样，用当前全文重建。
 * - 文本文件（YAML、JSON、日志等）用文本文件编辑器，和原文、预览开关无关。日志打开时、
 *   以及重新载入前滚到了底部时，滚到末尾（跟随新内容）。
 */
export function Editor() {
  const host = useRef<HTMLDivElement>(null);
  const kind = useApp(editorKind);
  const docId = useApp((s) => s.docId);
  // 下标设置改变解析方式，要用新选项重建编辑器（解析选项已由 store 同步到 md-blocks）
  const subscript = useApp((s) => s.subscript);
  const carry = useRef<Carry>({ docId, text: useApp.getState().text, scrollTop: 0 });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const scroller = parent.parentElement;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (carry.current.docId !== docId) {
      // 外部修改后重新载入同一个文件：保留光标所在块和滚动位置；换了文件就从头开始
      const keep = useApp.getState().keepView;
      carry.current = {
        docId,
        text: useApp.getState().text,
        block: keep ? carry.current.block : undefined,
        scrollTop: keep ? carry.current.scrollTop : 0,
        atEnd: keep ? carry.current.atEnd : undefined,
      };
    }

    const opts: EditorOptions = {
      parent,
      source: carry.current.text,
      placeholder: t.editorPlaceholder,
      labels: { frontmatter: t.frontmatterSummary, language: t.codeLanguage },
      resolveUrl: (src) => backend.resolveImage(src, useApp.getState().filePath),
      onOpenLink: (href, kind) => void (kind === 'wikilink' && useApp.getState().folder ? openWikiLink(href) : openLink(href, kind)),
      linkStatus,
      resolveEmbed,
      completeLinks,
      onPasteFiles: pasteImages,
      onPasteEmpty: pasteFromSystem,
      onChange: () => {
        noteEdit();
        clearTimeout(timer);
        timer = setTimeout(() => useApp.getState().setText(handle.getText()), SYNC_DELAY);
      },
    };
    const { filePath, readOnly } = useApp.getState();
    const handle =
      kind === 'code'
        ? createCodeEditor({ ...opts, fileName: basename(filePath ?? ''), readOnly })
        : kind === 'wysiwyg'
          ? createWysiwygEditor(opts)
          : createLiveEditor({ ...opts, rendered: kind === 'live' });
    const { focusMode, typewriter } = useApp.getState();
    handle.setFocusMode(focusMode);
    handle.setTypewriter(typewriter);

    const follow = kind === 'code' && !!filePath && LOG_FILE.test(filePath) && carry.current.atEnd !== false;
    if (scroller) scroller.scrollTop = carry.current.scrollTop;
    if (carry.current.block !== undefined && !follow) handle.setCursorBlock(carry.current.block);
    // 日志：等编辑器排好版再滚到底
    if (follow && scroller) requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
    setActiveEditor(handle, docId);

    return () => {
      clearTimeout(timer);
      const hadFocus = parent.contains(document.activeElement);
      const block = hadFocus ? handle.getCursorBlock() : undefined;
      const scrollTop = scroller?.scrollTop ?? 0;
      const atEnd = scroller ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 40 : false;
      // 换文档时 store 里已经是新文档，旧编辑器的内容不能再写回去
      if (useApp.getState().docId === docId) {
        const text = handle.getText();
        carry.current = { docId, text, block, scrollTop, atEnd };
        useApp.getState().setText(text);
      } else {
        carry.current = { ...carry.current, block, scrollTop, atEnd };
      }
      handle.destroy();
      if (activeEditor.current === handle) activeEditor.current = null;
    };
  }, [kind, docId, subscript]);

  // 专注模式、打字机模式变化时直接作用到当前编辑器，不重建
  const focusMode = useApp((s) => s.focusMode);
  const typewriter = useApp((s) => s.typewriter);
  useEffect(() => {
    activeEditor.current?.setFocusMode(focusMode);
  }, [focusMode]);
  useEffect(() => {
    activeEditor.current?.setTypewriter(typewriter);
  }, [typewriter]);

  // 点正文下方的空白（CodeMirror 内容区之外）：光标放到文末，和 Typora 一样
  const onMouseDown = (e: ReactMouseEvent) => {
    const target = e.target as HTMLElement;
    if (e.button !== 0 || target.closest('.cm-content, .ProseMirror, .cm-panels')) return;
    const content = host.current?.querySelector('.cm-content, .ProseMirror');
    if (content && e.clientY > content.getBoundingClientRect().bottom - 1) {
      e.preventDefault();
      activeEditor.current?.focusEnd();
    }
  };

  return <div ref={host} className="editor-host" onMouseDown={onMouseDown} />;
}
