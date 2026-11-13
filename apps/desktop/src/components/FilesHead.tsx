import { type MouseEvent as ReactMouseEvent, useCallback, useState } from 'react';
import { t } from '../i18n';
import { newDoc, openDialog, openFolder, openPath } from '../lib/document';
import { basename, dirname } from '../lib/paths';
import { newFolder, newNote } from '../lib/vault';
import { useApp, useBinding } from '../store';
import { ContextMenu, type MenuItem } from './ContextMenu';

/** 最近打开在"打开"菜单里最多列几个 */
const RECENT_IN_MENU = 8;

/**
 * 左栏"文件"页顶上一行：库名，右边"新建""打开""快速打开"三个图标按钮。
 * 新建、打开都弹一个小菜单（样式同右键菜单）。
 */
export function FilesHead() {
  const folder = useApp((s) => s.folder);
  const recent = useApp((s) => s.recent);
  const newKey = useBinding('file.new');
  const openKey = useBinding('file.open');
  const openFolderKey = useBinding('folder.open');
  const quickOpenKey = useBinding('file.quickOpen');
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const close = useCallback(() => setMenu(null), []);

  const popup = (e: ReactMouseEvent<HTMLButtonElement>, items: MenuItem[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu(menu ? null : { x: r.left, y: r.bottom + 4, items });
  };

  const newItems = (): MenuItem[] => {
    const items: MenuItem[] = [];
    if (folder) {
      items.push(
        { label: t.newNoteIn(basename(folder) || folder), onSelect: () => void newNote(folder) },
        { label: t.newFolder, onSelect: () => void newFolder(folder) },
        'separator',
      );
    }
    items.push({ label: t.cmdNewFile, hint: newKey, onSelect: () => void newDoc() });
    return items;
  };

  const openItems = (): MenuItem[] => {
    const items: MenuItem[] = [
      { label: t.cmdOpenFile, hint: openKey, onSelect: () => void openDialog() },
      { label: t.cmdOpenFolder, hint: openFolderKey, onSelect: () => void openFolder() },
    ];
    const list = recent.slice(0, RECENT_IN_MENU);
    if (list.length) {
      items.push('separator');
      for (const path of list) {
        items.push({ label: basename(path), hint: basename(dirname(path)), onSelect: () => void openPath(path) });
      }
    }
    return items;
  };

  return (
    <div className="sidebar-head">
      <span className={folder ? 'sidebar-folder' : 'sidebar-folder muted'} title={folder ?? undefined}>
        {folder ? basename(folder) || folder : t.vaultEmpty}
      </span>
      <button
        type="button"
        className="icon-button"
        title={t.newMenu}
        aria-label={t.newMenu}
        aria-haspopup="menu"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => popup(e, newItems())}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <button
        type="button"
        className="icon-button"
        title={t.openMenu}
        aria-label={t.openMenu}
        aria-haspopup="menu"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => popup(e, openItems())}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
        </svg>
      </button>
      {folder && (
        <button
          type="button"
          className="icon-button"
          title={`${t.quickOpen} ${quickOpenKey}`}
          aria-label={t.quickOpen}
          onClick={() => useApp.getState().setQuickOpen(true)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
        </button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} />}
    </div>
  );
}
