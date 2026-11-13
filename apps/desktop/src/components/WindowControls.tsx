import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';
import { t } from '../i18n';

/** Windows / Linux 自绘的最小化、最大化、关闭按钮（macOS 用系统红绿灯） */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    const sync = () => win.isMaximized().then((m) => !disposed && setMaximized(m));
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      disposed = true;
      unlisten.then((f) => f());
    };
  }, []);

  const win = getCurrentWindow();
  return (
    <div className="window-controls">
      <button type="button" aria-label={t.minimize} title={t.minimize} onClick={() => win.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={maximized ? t.restore : t.maximize}
        title={maximized ? t.restore : t.maximize}
        onClick={() => win.toggleMaximize()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M.5.5h9v9h-9z" />
          </svg>
        )}
      </button>
      <button type="button" className="close" aria-label={t.close} title={t.close} onClick={() => win.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M.5.5l9 9M9.5.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}
