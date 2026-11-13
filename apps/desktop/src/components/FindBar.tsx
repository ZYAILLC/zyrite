import type { FindQuery } from '@zyrite/editor-common';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n';
import { activeEditor, onEditorReady } from '../lib/editorRef';
import { isMac } from '../lib/platform';
import { useApp } from '../store';

interface Stats {
  count: number;
  current: number;
}

function regexpError(q: FindQuery): boolean {
  if (!q.regexp || !q.search) return false;
  try {
    new RegExp(q.search, 'u');
    return false;
  } catch {
    return true;
  }
}

/**
 * 当前文件查找替换：编辑区顶部一行工具条，细线分隔，不用横幅。
 * ↵ 下一处，⇧↵ 上一处；替换框里 ↵ 替换当前，⌘↵ 全部替换；Esc 关闭。
 */
export function FindBar() {
  const find = useApp((s) => s.find);
  const text = useApp((s) => s.text);
  const [search, setSearch] = useState('');
  const [replace, setReplace] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [stats, setStats] = useState<Stats>({ count: 0, current: 0 });
  const input = useRef<HTMLInputElement>(null);
  const query = useMemo<FindQuery>(
    () => ({ search, replace, caseSensitive, regexp }),
    [search, replace, caseSensitive, regexp],
  );
  const queryRef = useRef(query);
  queryRef.current = query;

  // 每次 ⌘F：用选中的文字（单行）预填，聚焦并全选
  useEffect(() => {
    if (!find.open) return;
    const sel = activeEditor.current?.getSelectedText() ?? '';
    if (sel && !sel.includes('\n')) setSearch(sel);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, [find.open, find.seq]);

  // 查询、正文变化时重新计数
  useEffect(() => {
    if (!find.open) return;
    const editor = activeEditor.current;
    if (editor) setStats(editor.find.setQuery(query));
  }, [find.open, query, text]);

  // 编辑器重建（切换模式、换文档）后把查询设到新编辑器上
  useEffect(
    () =>
      onEditorReady((editor) => {
        if (useApp.getState().find.open) setStats(editor.find.setQuery(queryRef.current));
      }),
    [],
  );

  if (!find.open) return null;

  const editor = () => activeEditor.current;
  const close = () => {
    editor()?.find.close();
    useApp.getState().closeFind();
  };
  const next = () => editor() && setStats(editor()!.find.next());
  const prev = () => editor() && setStats(editor()!.find.prev());
  const replaceOne = () => editor() && setStats(editor()!.find.replace());
  const replaceAll = () => {
    const ed = editor();
    if (!ed) return;
    const n = ed.find.replaceAll();
    setStats(ed.find.setQuery(query));
    useApp.getState().setNotice({ text: t.replacedCount(n) });
  };
  const toggleReplace = () => useApp.setState({ find: { ...find, replace: !find.replace } });

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (e.shiftKey) prev();
    else next();
  };
  const onReplaceKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (isMac ? e.metaKey : e.ctrlKey) replaceAll();
    else replaceOne();
  };

  const status = !search
    ? ''
    : regexpError(query)
      ? t.findBadRegexp
      : stats.count
        ? t.findCount(stats.current, stats.count)
        : t.findNone;
  const allKey = isMac ? '⌘↵' : 'Ctrl+↵';

  return (
    <div className="findbar" role="search" onKeyDown={onKeyDown}>
      <div className="findbar-row">
        <input
          ref={input}
          className="findbar-input"
          aria-label={t.find}
          placeholder={t.find}
          spellCheck={false}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onFindKey}
        />
        <button
          type="button"
          className="findbar-opt"
          aria-pressed={caseSensitive}
          title={t.matchCase}
          aria-label={t.matchCase}
          onClick={() => setCaseSensitive(!caseSensitive)}
        >
          Aa
        </button>
        <button
          type="button"
          className="findbar-opt mono"
          aria-pressed={regexp}
          title={t.useRegexp}
          aria-label={t.useRegexp}
          onClick={() => setRegexp(!regexp)}
        >
          .*
        </button>
        <span className="findbar-status" aria-live="polite">
          {status}
        </span>
        <button type="button" title={`${t.findPrev} ⇧↵`} aria-label={t.findPrev} onClick={prev}>
          ↑
        </button>
        <button type="button" title={`${t.findNext} ↵`} aria-label={t.findNext} onClick={next}>
          ↓
        </button>
        <button type="button" aria-pressed={find.replace} onClick={toggleReplace} title={t.toggleReplace}>
          {t.replace}
        </button>
        <button type="button" className="findbar-close" title={`${t.closeFind} Esc`} aria-label={t.closeFind} onClick={close}>
          ×
        </button>
      </div>
      {find.replace && (
        <div className="findbar-row">
          <input
            className="findbar-input"
            aria-label={t.replaceWith}
            placeholder={t.replaceWith}
            spellCheck={false}
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            onKeyDown={onReplaceKey}
          />
          <button type="button" onClick={replaceOne} title={`${t.replace} ↵`}>
            {t.replace}
          </button>
          <button type="button" onClick={replaceAll} title={`${t.replaceAll} ${allKey}`}>
            {t.replaceAll}
          </button>
        </div>
      )}
    </div>
  );
}
