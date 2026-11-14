import { renderMarkdown } from '@zyrite/editor-common';
import { type KeyboardEvent, memo, useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { chatService, openAiSettings, type RewriteAction, rewritePrompt, selectionContext, serviceName, streamChat } from '../lib/ai';
import { backend } from '../lib/backend';
import { activeEditor } from '../lib/editorRef';
import { isMac } from '../lib/platform';
import { useApp } from '../store';

const mod = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);

const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) void renderMarkdown(ref.current, text, (src) => backend.resolveImage(src, useApp.getState().filePath));
  }, [text]);
  return <div ref={ref} className={className} />;
});

// ---------- 选中改写 ----------

/** 选中文字 → 润色、续写、缩写、翻译、改语气或自由指令；结果显示在原文下方，流式输出 */
export function AiRewrite() {
  const req = useApp((s) => s.aiRewrite);
  const chat = useApp((s) => chatService(s.ai));
  const [action, setAction] = useState<RewriteAction | null>(null);
  const [instruction, setInstruction] = useState('');
  const [result, setResult] = useState('');
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const cancel = useRef<(() => void) | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    cancel.current?.();
    useApp.setState({ aiRewrite: null });
    setAction(null);
    setResult('');
    setState('idle');
    setInstruction('');
    activeEditor.current?.focus();
  }, []);

  const run = useCallback(
    (a: RewriteAction, extra = instruction) => {
      if (!req || !chat) return;
      cancel.current?.();
      setAction(a);
      setResult('');
      setError('');
      setState('running');
      const sel = req.selection;
      const context = selectionContext(sel.prefix, sel.text, sel.suffix);
      cancel.current = streamChat(chat, rewritePrompt(a, sel.text, context, extra), {
        onDelta: (_d, full) => setResult(full),
        onDone: () => setState('done'),
        onError: (m) => {
          setError(m);
          setState('error');
        },
      });
    },
    [req, chat, instruction],
  );

  const apply = useCallback(
    (after: boolean) => {
      if (!result.trim()) return;
      // 续写的结果总是接在后面
      activeEditor.current?.replaceSelection(result.trim(), after || action === 'continue');
      close();
    },
    [result, action, close],
  );

  // 面板打开时接管 ⌘↵ ⌥↵ ⌘R Esc（捕获阶段，先于编辑器）
  useEffect(() => {
    if (!req) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Enter' && mod(e) && state === 'done') {
        e.preventDefault();
        apply(false);
      } else if (e.key === 'Enter' && e.altKey && state === 'done') {
        e.preventDefault();
        apply(true);
      } else if ((e.key === 'r' || e.key === 'R') && mod(e) && action) {
        e.preventDefault();
        run(action);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [req, state, action, apply, close, run]);

  useEffect(() => () => cancel.current?.(), []);
  if (!req) return null;

  const r = req.selection.rect;
  const top = Math.min(r.bottom + 8, window.innerHeight - 260);
  const left = Math.max(12, Math.min(r.left, window.innerWidth - 560));
  const actions: [RewriteAction, string][] = [
    ['polish', t.aiPolish],
    ['continue', t.aiContinue],
    ['shorten', t.aiShorten],
    ['translate', /[一-鿿]/.test(req.selection.text) ? t.aiTranslateEn : t.aiTranslateZh],
    ['tone', t.aiTone],
  ];
  const key = (k: string) => (isMac ? k : k.replace('⌘', 'Ctrl+').replace('⌥', 'Alt+'));

  return (
    <div className="ai-rewrite" ref={panel} style={{ top, left }} role="dialog" aria-label={t.aiRewrite}>
      {!chat ? (
        <button type="button" className="text-button" onClick={openAiSettings}>
          {t.aiGoSettings}
        </button>
      ) : (
        <>
          <div className="ai-actions">
            {actions.map(([a, label]) => (
              <button key={a} type="button" aria-pressed={action === a} onClick={() => run(a)}>
                {label}
              </button>
            ))}
            <span className="ai-model">{serviceName(chat)}</span>
          </div>
          <input
            className="ai-instruction"
            placeholder={t.aiInstruction}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && !mod(e) && !e.altKey && instruction.trim()) {
                e.preventDefault();
                run(action === 'tone' ? 'tone' : 'custom', instruction);
              }
            }}
          />
          {state !== 'idle' && (
            <div className="ai-result" aria-live="polite">
              {state === 'error' ? <p className="status-error">{error}</p> : <Markdown text={result || '…'} />}
            </div>
          )}
          {state === 'done' && (
            <div className="ai-keys">
              <button type="button" onClick={() => apply(false)}>
                <b>{key('⌘↵')}</b> {t.aiReplace}
              </button>
              <button type="button" onClick={() => apply(true)}>
                <b>{key('⌥↵')}</b> {t.aiInsertBelow}
              </button>
              <button type="button" onClick={() => action && run(action)}>
                <b>{key('⌘R')}</b> {t.aiRetry}
              </button>
              <button type="button" onClick={close}>
                <b>Esc</b> {t.aiDiscard}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
