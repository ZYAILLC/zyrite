import { t } from '../i18n';
import { isMac, isTauri } from '../lib/platform';
import { useApp, useBinding } from '../store';
import { WindowControls } from './WindowControls';

interface Props {
  /** 库内相对目录，例如 `产品笔记/方案`；没有就只显示文件名 */
  dir?: string;
  fileName: string;
  /** 有未保存的修改 */
  dirty?: boolean;
}

/** 标题栏 40px：只显示文件路径（不放 logo），右侧"简洁 | 完整" */
export function TitleBar({ dir, fileName, dirty }: Props) {
  const edition = useApp((s) => s.edition);
  const setEdition = useApp((s) => s.setEdition);
  const shortcut = useBinding('edition.toggle');

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-lead" data-tauri-drag-region />
      <div className="titlebar-title" data-tauri-drag-region>
        {dir && <span className="muted">{dir} / </span>}
        <strong>{fileName}</strong>
        {dirty && <span className="muted"> — {t.edited}</span>}
      </div>
      <div className="titlebar-trail" data-tauri-drag-region>
        <div role="group" aria-label={t.edition} title={`${t.toggleEdition} ${shortcut}`} className="edition-switch">
          <button type="button" aria-pressed={edition === 'simple'} onClick={() => setEdition('simple')}>
            {t.editionSimple}
          </button>
          <span aria-hidden="true" className="edition-sep">
            |
          </span>
          <button type="button" aria-pressed={edition === 'full'} onClick={() => setEdition('full')}>
            {t.editionFull}
          </button>
        </div>
        {isTauri && !isMac && <WindowControls />}
      </div>
    </header>
  );
}
