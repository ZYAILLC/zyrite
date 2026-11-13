import type { SelectionInfo } from '@zyrite/editor-common';
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { locale, t } from '../i18n';
import type { AgentInfo, Annotation } from '../lib/backend';
import {
  applyMarks,
  createAnnotation,
  deleteAnnotation,
  followUp,
  parseTime,
  setAssignee,
  setStatus,
  shownStatus,
  USER,
} from '../lib/annotations';
import { deps } from '../lib/document';
import { activeEditor, onEditorReady } from '../lib/editorRef';
import { isMac } from '../lib/platform';
import { relInVault } from '../lib/vault';
import { useApp } from '../store';

/** 边注列宽 */
const MARGIN_WIDTH = 240;
const MARGIN_GAP = 28;

function timeOf(at: string): string {
  const ms = parseTime(at);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(locale, today ? { hour: '2-digit', minute: '2-digit' } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function useAgents(): AgentInfo[] {
  const agentVersion = useApp((s) => s.agentVersion);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  useEffect(() => {
    let alive = true;
    deps.backend
      .agentsGet()
      .then((a) => alive && setAgents(a))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentVersion]);
  return agents;
}

/** 是否可以批注：完整版、文件在库里 */
function useCanAnnotate(): boolean {
  const edition = useApp((s) => s.edition);
  const filePath = useApp((s) => s.filePath);
  const folder = useApp((s) => s.folder);
  return edition === 'full' && !!folder && !!filePath && relInVault(filePath) !== null;
}

// ---------- 选中文字后的浮动菜单 ----------

/** 选中文字后浮在上方的菜单："批注给 Agent / AI 改写 / 复制段落链接" */
export function SelectionMenu() {
  const canAnnotate = useCanAnnotate();
  const [sel, setSel] = useState<SelectionInfo | null>(null);
  // 刚对这段选中的文字做过操作（批注、改写）：选区不变就不再弹出
  const handled = useRef<string | null>(null);
  // 审阅、合并、设置、面板、写批注时都不显示
  const busy = useApp((s) => !!(s.review || s.merge || s.settingsTab || s.palette || s.composer || s.aiRewrite));
  const margin = useApp((s) => s.annMargin);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const active = document.activeElement;
        const inEditor = !!active?.closest?.('.editor-host');
        setSel(inEditor ? (activeEditor.current?.getSelectionInfo() ?? null) : null);
      });
    };
    const hide = () => setSel(null);
    document.addEventListener('selectionchange', update);
    document.addEventListener('mouseup', update);
    document.addEventListener('keyup', update);
    const scroller = document.querySelector('.editor-scroll');
    scroller?.addEventListener('scroll', hide);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('mouseup', update);
      document.removeEventListener('keyup', update);
      scroller?.removeEventListener('scroll', hide);
    };
  }, []);

  const selKey = sel ? `${sel.prefix}\u0000${sel.text}\u0000${sel.suffix}` : null;
  if (selKey !== handled.current && handled.current !== null && !sel) handled.current = null;
  if (!sel || busy || !sel.text.trim() || selKey === handled.current || !document.activeElement?.closest('.editor-host')) {
    return null;
  }
  const top = Math.max(48, sel.rect.top - 40);
  const left = Math.max(8, Math.min((sel.rect.left + sel.rect.right) / 2 - 160, window.innerWidth - 330));

  const annotate = () => {
    const scroller = document.querySelector<HTMLElement>('.editor-scroll');
    const base = scroller ? scroller.getBoundingClientRect().top - scroller.scrollTop : 0;
    useApp.setState({ composer: { anchor: { text: sel.text, prefix: sel.prefix, suffix: sel.suffix }, top: sel.rect.top - base } });
    handled.current = selKey;
    setSel(null);
  };
  const copyLink = () => {
    const { filePath, text } = useApp.getState();
    const stem = filePath ? filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1).replace(/\.[^.]+$/, '') : '';
    // 选中文字之前最近的标题
    const at = text.indexOf(sel.text);
    const headings = [...text.slice(0, at < 0 ? 0 : at).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)];
    const heading = headings.at(-1)?.[1];
    const link = heading ? `[[${stem}#${heading}]]` : `[[${stem}]]`;
    void navigator.clipboard?.writeText(link).then(() => useApp.getState().setNotice({ text: `${t.copied} ${link}` }));
    setSel(null);
  };
  const rewrite = () => {
    useApp.setState({ aiRewrite: { selection: sel } });
    handled.current = selKey;
    setSel(null);
  };

  return (
    <div className="selection-menu" role="toolbar" style={{ top, left }} onMouseDown={(e) => e.preventDefault()}>
      {/* 批注只以边注显示：正文右侧放不下（比如原文 + 预览分栏）时不提供 */}
      {canAnnotate && margin && (
        <button type="button" onClick={annotate}>
          {t.annotateAgent}
        </button>
      )}
      <button type="button" onClick={rewrite}>
        {t.aiRewrite}
      </button>
      <button type="button" onClick={copyLink}>
        {t.copyBlockLink}
      </button>
    </div>
  );
}

// ---------- 批注卡片 ----------

function AssigneeSelect({ value, onChange, agents }: { value: string; onChange: (v: string) => void; agents: AgentInfo[] }) {
  const names = [...new Set([...agents.map((a) => a.name), ...(value !== 'any' ? [value] : [])])];
  return (
    <label className="ann-assignee">
      {t.assignTo}{' '}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="any">{t.anyAgent}</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

function Card({ a, n, agents }: { a: Annotation; n: number; agents: AgentInfo[] }) {
  const text = useApp((s) => s.text);
  const review = useApp((s) => s.review);
  const status = shownStatus(a, text);
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState('');
  const send = () => {
    void followUp(a.id, draft);
    setDraft('');
    setAsking(false);
  };
  return (
    <article className={`ann-card status-${status}`} data-ann={a.id} onClick={() => activeEditor.current?.revealAnnotation(a.id)}>
      <div className="ann-head">
        <span className="ann-n">{n}</span>
        <span className="ann-status">{t.annStatus[status]}</span>
        <button
          type="button"
          className="ann-delete"
          aria-label={t.deleteAnnotation}
          title={t.deleteAnnotation}
          onClick={(e) => {
            e.stopPropagation();
            void deleteAnnotation(a.id);
          }}
        >
          ×
        </button>
      </div>
      <div className="ann-entry">
        <div className="ann-meta">
          {t.you} · {timeOf(a.createdAt)}
        </div>
        <div>{a.body}</div>
      </div>
      {a.thread.map((e, i) => (
        <div className="ann-entry" key={i}>
          <div className="ann-meta">
            {e.by === USER ? t.you : e.by} · {timeOf(e.at)}
          </div>
          <div>{e.text}</div>
        </div>
      ))}
      {status === 'open' && (
        <AssigneeSelect value={a.assignee} agents={agents} onChange={(v) => void setAssignee(a.id, v)} />
      )}
      <div className="ann-actions" onClick={(e) => e.stopPropagation()}>
        {status === 'changed' && review && (
          <button type="button" onClick={() => useApp.setState({ reviewFocus: 0 })}>
            {t.viewChanges}
          </button>
        )}
        {a.status !== 'resolved' ? (
          <button type="button" onClick={() => void setStatus(a.id, 'resolved')}>
            {t.markResolved}
          </button>
        ) : (
          <button type="button" onClick={() => void setStatus(a.id, 'open')}>
            {t.reopen}
          </button>
        )}
        {!asking && (
          <button type="button" onClick={() => setAsking(true)}>
            {t.followUp}
          </button>
        )}
      </div>
      {asking && (
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={send}
          onCancel={() => setAsking(false)}
          autoFocus
        />
      )}
    </article>
  );
}

function Composer(props: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
      e.preventDefault();
      props.onSend();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      props.onCancel();
    }
  };
  return (
    <div className="ann-composer" onClick={(e) => e.stopPropagation()}>
      <textarea
        autoFocus={props.autoFocus}
        rows={3}
        placeholder={t.annPlaceholder}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="ann-composer-foot">
        <span className="muted">{isMac ? '⌘↵' : 'Ctrl+↵'}</span>
        <button type="button" className="primary" disabled={!props.value.trim()} onClick={props.onSend}>
          {t.send}
        </button>
      </div>
    </div>
  );
}

/** 新批注：选中文字后点"批注给 Agent" */
function NewAnnotation({ agents }: { agents: AgentInfo[] }) {
  const composer = useApp((s) => s.composer);
  const [body, setBody] = useState('');
  const [assignee, setAssigneeState] = useState('any');
  if (!composer) return null;
  const close = () => {
    useApp.setState({ composer: null });
    setBody('');
    activeEditor.current?.focus();
  };
  return (
    <article className="ann-card new">
      <div className="ann-quote">“{composer.anchor.text}”</div>
      <Composer
        value={body}
        onChange={setBody}
        autoFocus
        onCancel={close}
        onSend={() => {
          void createAnnotation(composer.anchor, body, assignee);
          close();
        }}
      />
      <AssigneeSelect value={assignee} onChange={setAssigneeState} agents={agents} />
    </article>
  );
}

function FilterBar({ list }: { list: Annotation[] }) {
  const filter = useApp((s) => s.annFilter);
  const text = useApp((s) => s.text);
  const count = (st: string) => list.filter((a) => shownStatus(a, text) === st || (st === 'open' && shownStatus(a, text) === 'orphaned')).length;
  const options: ['all' | 'open' | 'changed' | 'resolved', string][] = [
    ['all', t.annFilterAll],
    ['open', `${t.annFilter.open} ${count('open')}`],
    ['changed', `${t.annFilter.changed} ${count('changed')}`],
    ['resolved', `${t.annFilter.resolved} ${count('resolved')}`],
  ];
  return (
    <div className="ann-filter" role="group">
      <span className="section-label">
        {t.annotations} {list.length}
      </span>
      {options.map(([v, label]) => (
        <button key={v} type="button" aria-pressed={filter === v} onClick={() => useApp.setState({ annFilter: v })}>
          {label}
        </button>
      ))}
    </div>
  );
}

function useVisible(): { a: Annotation; n: number }[] {
  const list = useApp((s) => s.annotations);
  const filter = useApp((s) => s.annFilter);
  const text = useApp((s) => s.text);
  return useMemo(
    () =>
      list
        .map((a, i) => ({ a, n: i + 1 }))
        .filter(({ a }) => {
          if (filter === 'all') return true;
          const st = shownStatus(a, text);
          return filter === 'open' ? st === 'open' || st === 'orphaned' : st === filter;
        }),
    [list, filter, text],
  );
}

/** 让编辑器标出批注：批注变化、编辑器重建后都要重新设 */
function useApplyMarks() {
  const list = useApp((s) => s.annotations);
  useEffect(() => applyMarks(), [list]);
  useEffect(() => onEditorReady(() => applyMarks()), []);
}

// ---------- 边注（正文右侧） ----------

/** 正文右侧有没有放边注的地方 */
/**
 * 正文靠左时右边放不放得下边注，以及边注的横向位置。
 * 按靠左算，而不是按现在的位置：正文平时居中，有批注时才靠左让位（见 data-ann-shift），
 * 否则 1200 宽的窗口两边各剩 140，永远放不下。
 */
function useMarginRoom(): { room: boolean; left: number } {
  const [place, setPlace] = useState({ room: false, left: 0 });
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>('.editor-scroll');
    if (!scroller) return;
    const check = () => {
      // 纯源码（原文 + 预览分栏）没有 #write，源码占满整栏，放不下边注
      const content = scroller.querySelector<HTMLElement>('#write');
      if (!content) {
        setPlace((p) => (p.room ? { room: false, left: 0 } : p));
        return;
      }
      const padRight = parseFloat(getComputedStyle(content).paddingRight) || 0;
      // 文字的右边界（右内边距可以让给边注）
      const left = content.getBoundingClientRect().width - padRight + MARGIN_GAP;
      const room = left + MARGIN_WIDTH + 12 <= scroller.clientWidth;
      setPlace((p) => (p.room === room && p.left === left ? p : { room, left }));
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(scroller);
    return () => ro.disconnect();
  });
  return place;
}

export function AnnotationMargin() {
  const canAnnotate = useCanAnnotate();
  const { room, left } = useMarginRoom();
  const visible = useVisible();
  const list = useApp((s) => s.annotations);
  const composer = useApp((s) => s.composer);
  const text = useApp((s) => s.text);
  const agents = useAgents();
  const layer = useRef<HTMLDivElement>(null);
  const [tops, setTops] = useState<Record<string, number>>({});
  useApplyMarks();

  useEffect(() => {
    useApp.setState({ annMargin: canAnnotate && room });
  }, [canAnnotate, room]);

  // 有批注（或正在写）时正文靠左，给边注让位；写在滚动容器上，App 重新渲染时不会被覆盖
  const shift = canAnnotate && room && (list.length > 0 || !!composer);
  useLayoutEffect(() => {
    const scroller = document.querySelector<HTMLElement>('.editor-scroll');
    if (!scroller || !shift) return;
    scroller.setAttribute('data-ann-shift', '');
    return () => scroller.removeAttribute('data-ann-shift');
  }, [shift]);

  const measure = useCallback(() => {
    const scroller = document.querySelector<HTMLElement>('.editor-scroll');
    if (!scroller) return;
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const raw = activeEditor.current?.annotationTops() ?? {};
    const out: Record<string, number> = {};
    for (const [id, top] of Object.entries(raw)) out[id] = top - base;
    setTops(out);
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [measure, list, text, room]);

  // 卡片按对齐位置往下挤，避免重叠
  useLayoutEffect(() => {
    const el = layer.current;
    if (!el) return;
    let bottom = 0;
    for (const slot of el.querySelectorAll<HTMLElement>('.ann-slot')) {
      const want = Number(slot.dataset.top ?? 0);
      const top = Math.max(want, bottom + 8);
      slot.style.top = `${top}px`;
      bottom = top + slot.offsetHeight;
    }
  });

  if (!canAnnotate || !room || (!list.length && !composer)) return null;
  const ordered = [...visible].sort((x, y) => (tops[x.a.id] ?? 1e9) - (tops[y.a.id] ?? 1e9));

  return (
    <div className="ann-margin" ref={layer} style={{ left, width: MARGIN_WIDTH }}>
      <div className="ann-slot" data-top={0}>
        <FilterBar list={list} />
      </div>
      {composer && (
        <div className="ann-slot" data-top={composer.top}>
          <NewAnnotation agents={agents} />
        </div>
      )}
      {ordered.map(({ a, n }) => (
        <div key={a.id} className="ann-slot" data-top={tops[a.id] ?? 0}>
          <Card a={a} n={n} agents={agents} />
        </div>
      ))}
    </div>
  );
}
