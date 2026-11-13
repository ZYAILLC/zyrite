import { UserAttentionType, getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { answerRequest } from '../lib/access';
import { isTauri } from '../lib/platform';
import { useApp } from '../store';

/** Agent 等用户回答的最长时间，和 `zyrite mcp` 里的一致（grants::WAIT_MS） */
const WAIT_MS = 60_000;

/**
 * Agent 第一次访问库时的授权弹窗。
 * Agent 的工具调用在这期间等着，最多 60 秒；超时后它会收到"超时"，弹窗自动消失。
 */
export function AccessPrompt() {
  const folder = useApp((s) => s.folder);
  const requests = useApp((s) => s.access.requests);
  const [now, setNow] = useState(Date.now());
  const live = requests.filter((r) => now - r.createdMs < WAIT_MS);
  const req = live[0];

  useEffect(() => {
    if (!requests.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [requests.length]);

  // 有新请求时把窗口叫到前面（在别的应用里用 Agent 时也能看到）
  useEffect(() => {
    if (!req || !isTauri) return;
    const w = getCurrentWindow();
    w.requestUserAttention(UserAttentionType.Critical).catch(() => {});
  }, [req?.id]);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        void answerRequest(req.id, false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [req?.id]);

  if (!req || !folder) return null;
  const left = Math.max(0, Math.ceil((WAIT_MS - (now - req.createdMs)) / 1000));
  return (
    <div className="palette-backdrop">
      <div className="access-prompt" role="alertdialog" aria-labelledby="access-title" aria-describedby="access-desc">
        <h2 id="access-title">{t.accessTitle(req.name)}</h2>
        <p id="access-desc" className="muted">
          {t.accessDesc}
        </p>
        <dl className="access-facts">
          <dt>{t.accessProgram}</dt>
          <dd className="mono">{req.exe || t.accessUnknownProgram}</dd>
          <dt>{t.accessVault}</dt>
          <dd className="mono">{folder}</dd>
          <dt>{t.accessCan}</dt>
          <dd>
            {t.permRead}
            <br />
            {t.permWrite}
          </dd>
          <dt>{t.accessCannot}</dt>
          <dd>{t.permDirect}</dd>
        </dl>
        <p className="settings-hint">{t.accessLater}</p>
        <div className="access-actions">
          <span className="muted">
            {t.accessWaiting(left)}
            {live.length > 1 && ` · ${t.accessMore(live.length - 1)}`}
          </span>
          <button type="button" className="access-deny" onClick={() => void answerRequest(req.id, false)}>
            {t.accessDeny}
          </button>
          <button type="button" className="primary" onClick={() => void answerRequest(req.id, true)}>
            {t.accessAllow}
          </button>
        </div>
      </div>
    </div>
  );
}
