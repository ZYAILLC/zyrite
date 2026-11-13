import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n';
import type { SearchResult, TagCount } from '../lib/backend';
import { type Command, listCommands } from '../lib/commands';
import { deps, openPath, quickOpenRoot } from '../lib/document';
import { activeEditor } from '../lib/editorRef';
import { fuzzyFilter } from '../lib/fuzzy';
import { formatBinding } from '../lib/keymap';
import { openAt } from '../lib/linkIndex';
import { basename, dirname, resolvePath } from '../lib/paths';
import { isMac } from '../lib/platform';
import { type PaletteMode, useApp } from '../store';

/**
 * 面板：
 * - ⌘K 命令面板：同时搜文件名、全文、命令；`>` 只搜命令，`#` 只搜标签
 * - ⌘P 快速打开：最近打开 + 文件夹里的文件
 * - ⌘⇧F 全文搜索：只搜内容，结果更多
 * - 点左栏标签：列出这个标签下的笔记
 */
export function Palette() {
  const palette = useApp((s) => s.palette);
  // mode 或 tag 变了就重新挂载，清空输入
  return palette ? <PaletteDialog key={`${palette.mode}:${palette.tag ?? ''}`} mode={palette.mode} tag={palette.tag} /> : null;
}

type Section = 'recent' | 'files' | 'content' | 'commands' | 'tags';

interface Row {
  key: string;
  section: Section;
  run: () => void;
  render: (selected: boolean) => ReactNode;
}

/** 把命中的字符加粗 */
function highlight(text: string, positions: readonly number[], offset: number): ReactNode[] {
  const set = new Set(positions);
  const out: ReactNode[] = [];
  let buf = '';
  let bold = false;
  const flush = (key: number) => {
    if (buf) out.push(bold ? <b key={key}>{buf}</b> : buf);
    buf = '';
  };
  [...text].forEach((ch, i) => {
    const hit = set.has(i + offset);
    if (hit !== bold) {
      flush(i);
      bold = hit;
    }
    buf += ch;
  });
  flush(text.length);
  return out;
}

interface FileItem {
  path: string;
  /** 文件夹内的相对路径，或文件夹外的绝对路径 */
  label: string;
  recent: boolean;
}

const stemOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

function PaletteDialog({ mode, tag }: { mode: PaletteMode; tag?: string }) {
  const folder = useApp((s) => s.folder);
  const allRecent = useApp((s) => s.recent);
  const root = useMemo(quickOpenRoot, []);
  const [files, setFiles] = useState<string[] | null>(null);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [search, setSearch] = useState<{ query: string; result: SearchResult } | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);

  const commandMode = mode === 'all' && q.startsWith('>');
  const tagMode = mode === 'all' && q.startsWith('#');
  const query = commandMode || tagMode ? q.slice(1) : q;

  // 文件列表（⌘P、⌘K、标签）
  useEffect(() => {
    if (mode === 'search') return;
    if (!root && mode !== 'tag') {
      setFiles([]);
      return;
    }
    let alive = true;
    (mode === 'tag' && tag ? deps.backend.notesWithTag(tag) : deps.backend.listMarkdown(root ?? ''))
      .then((f) => alive && setFiles(f))
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
    };
  }, [mode, root, tag]);

  useEffect(() => {
    if (!tagMode) return;
    let alive = true;
    deps.backend
      .tags()
      .then((list) => alive && setTags(list))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tagMode]);

  // 全文搜索：输入停 60 毫秒再查，只用最新一次的结果
  const wantSearch = (mode === 'search' || (mode === 'all' && !commandMode && !tagMode)) && !!folder && !!query.trim();
  useEffect(() => {
    if (!wantSearch) {
      setSearch(null);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      deps.backend
        .search(query, mode === 'search' ? 50 : 8)
        .then((result) => seq === searchSeq.current && setSearch({ query, result }))
        .catch(() => {});
    }, 60);
    return () => clearTimeout(timer);
  }, [query, wantSearch, mode]);

  const close = () => {
    useApp.getState().closePalette();
    activeEditor.current?.focus();
  };
  const runAndClose = (fn: () => void) => () => {
    useApp.getState().closePalette();
    fn();
  };

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const folderPrefix = root ? resolvePath(root, '.') : null;
    const relOf = (p: string) => {
      if (!folderPrefix) return p;
      const head = folderPrefix.endsWith('/') || folderPrefix.endsWith('\\') ? folderPrefix : `${folderPrefix}/`;
      return p.startsWith(head) ? p.slice(head.length).split('\\').join('/') : p;
    };

    const fileRows = (limit: number, withRecent: boolean) => {
      const recent = withRecent ? allRecent : [];
      const seen = new Set(recent);
      const items: FileItem[] = [
        ...recent.map((p) => ({ path: p, label: relOf(p), recent: true })),
        ...(files ?? [])
          .map((f) => ({ path: resolvePath(root ?? '', f), label: f, recent: false }))
          .filter((it) => !seen.has(it.path)),
      ];
      const matched = query.trim()
        ? fuzzyFilter(query, items, (it) => it.label, limit)
        : items.slice(0, limit).map((item) => ({ item, match: { positions: [] as number[], score: 0 } }));
      for (const { item, match } of matched) {
        const nameStart = Math.max(item.label.lastIndexOf('/'), item.label.lastIndexOf('\\')) + 1;
        const dir = dirname(item.label);
        out.push({
          key: `f:${item.path}`,
          section: item.recent && !query.trim() ? 'recent' : 'files',
          run: runAndClose(() => void openPath(item.path)),
          render: (selected) => (
            <>
              <span className="palette-name">{highlight(item.label.slice(nameStart), match.positions, nameStart)}</span>
              {dir && <span className="palette-hint">{highlight(dir, match.positions, 0)}</span>}
              {selected && <span className="palette-key">↵</span>}
            </>
          ),
        });
      }
    };

    const contentRows = (perNote: number, maxRows: number) => {
      if (!search || !folder) return;
      let n = 0;
      for (const hit of search.result.hits) {
        for (const m of hit.matches.slice(0, perNote)) {
          if (n++ >= maxRows) return;
          const path = resolvePath(folder, hit.rel);
          out.push({
            key: `c:${hit.rel}:${m.line}`,
            section: 'content',
            run: runAndClose(() => void openAt(path, m.line)),
            render: () => (
              <span className="palette-match">
                <span className="palette-hint">
                  {stemOf(hit.rel)} · {t.lineNo(m.line + 1)}
                </span>
                <span className="palette-snippet">
                  {m.before}
                  <b>{m.text}</b>
                  {m.after}
                </span>
              </span>
            ),
          });
        }
      }
    };

    const commandRows = (limit: number) => {
      const cmds = listCommands();
      const matched = query.trim()
        ? fuzzyFilter(query, cmds, (c) => c.label, limit)
        : cmds.slice(0, limit).map((item) => ({ item, match: { positions: [] as number[], score: 0 } }));
      for (const { item, match } of matched as { item: Command; match: { positions: number[] } }[]) {
        out.push({
          key: `k:${item.id}`,
          section: 'commands',
          run: runAndClose(item.run),
          render: () => (
            <>
              <span className="palette-name">{highlight(item.label, match.positions, 0)}</span>
              {item.binding && <span className="palette-key mono">{formatBinding(item.binding, isMac)}</span>}
            </>
          ),
        });
      }
    };

    if (mode === 'files' || mode === 'tag') fileRows(200, mode === 'files');
    else if (mode === 'search') contentRows(3, 150);
    else if (commandMode) commandRows(100);
    else if (tagMode) {
      const matched = fuzzyFilter(query, tags, (x) => x.tag, 50);
      for (const { item, match } of matched) {
        out.push({
          key: `t:${item.tag}`,
          section: 'tags',
          run: () => useApp.getState().openPalette('tag', item.tag),
          render: () => (
            <>
              <span className="palette-name">#{highlight(item.tag, match.positions, 0)}</span>
              <span className="palette-key">{item.count}</span>
            </>
          ),
        });
      }
    } else if (!query.trim()) {
      fileRows(5, true);
      commandRows(8);
    } else {
      fileRows(5, true);
      contentRows(2, 8);
      commandRows(5);
    }
    return out;
    // runAndClose 每次渲染都是新函数，不需要放进依赖
  }, [mode, files, tags, search, query, commandMode, tagMode, allRecent, root, folder]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, rows.length - 1)));
  }, [rows.length]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      rows[sel]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  const rootName = root ? basename(root) || root : '';
  const placeholder =
    mode === 'search' ? t.paletteSearch : mode === 'all' ? t.paletteAll : mode === 'tag' ? t.tagNotes(tag ?? '') : t.quickOpenPlaceholder;
  const sectionLabel = (s: Section): string => {
    switch (s) {
      case 'recent':
        return t.recentFiles;
      case 'files':
        return mode === 'tag' ? `${t.tagNotes(tag ?? '')} · ${files?.length ?? 0}` : mode === 'files' && !query.trim() ? t.filesIn(rootName) : t.sectionFiles;
      case 'content':
        return t.sectionContent(search?.result.totalNotes ?? 0, search?.result.totalMatches ?? 0);
      case 'commands':
        return t.sectionCommands;
      case 'tags':
        return t.sectionTags;
    }
  };
  const empty =
    mode === 'search' && !folder
      ? t.noIndex
      : !root && !allRecent.length && mode === 'files'
        ? t.quickOpenNoFolder
        : rows.length === 0 && (q.trim() || files !== null)
          ? t.quickOpenEmpty
          : null;

  let last: Section | null = null;
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label={placeholder} className="palette">
        <label className="palette-input">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            autoFocus
            aria-label={placeholder}
            placeholder={placeholder}
            spellCheck={false}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
          />
          {search && <span className="palette-timing">{search.result.elapsedMs} ms</span>}
        </label>
        <div className="palette-list" ref={list} id="palette-list" role="listbox">
          {empty && <p className="palette-empty">{empty}</p>}
          {rows.map((row, i) => {
            const header =
              row.section !== last ? (
                <div className="palette-section" key={`h-${row.section}`}>
                  {sectionLabel(row.section)}
                </div>
              ) : null;
            last = row.section;
            return [
              header,
              <div
                key={row.key}
                role="option"
                aria-selected={i === sel}
                className="palette-item"
                onMouseMove={() => i !== sel && setSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  row.run();
                }}
              >
                {row.render(i === sel)}
              </div>,
            ];
          })}
        </div>
      </div>
    </div>
  );
}
