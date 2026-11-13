import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { t } from '../i18n';
import { deps, openPath } from '../lib/document';
import { basename, dirname, resolvePath } from '../lib/paths';
import { isMac } from '../lib/platform';
import { moveEntry, newFolder, newNote, renameEntry, trashEntry } from '../lib/vault';
import { useApp } from '../store';
import { ContextMenu, type MenuItem } from './ContextMenu';

interface Node {
  name: string;
  /** 相对库根目录 */
  rel: string;
  dir: boolean;
  children: Node[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** 平铺的条目 → 树；文件夹在前，按名字自然排序（"2" 在 "10" 前面） */
export function buildTree(entries: readonly { path: string; dir: boolean }[]): Node[] {
  const root: Node = { name: '', rel: '', dir: true, children: [] };
  const dirs = new Map<string, Node>([['', root]]);
  const ensureDir = (rel: string): Node => {
    const found = dirs.get(rel);
    if (found) return found;
    const parent = ensureDir(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
    const node: Node = { name: rel.slice(rel.lastIndexOf('/') + 1), rel, dir: true, children: [] };
    parent.children.push(node);
    dirs.set(rel, node);
    return node;
  };
  for (const e of entries) {
    if (e.dir) ensureDir(e.path);
    else {
      const parent = ensureDir(e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '');
      parent.children.push({ name: e.path.slice(e.path.lastIndexOf('/') + 1), rel: e.path, dir: false, children: [] });
    }
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

/** 每层缩进 = 箭头 12px + 间距 4px：文件和上级文件夹的名字对齐 */
const ROW_INDENT = 16;

interface Menu {
  x: number;
  y: number;
  items: MenuItem[];
}

interface Drag {
  from: string;
  name: string;
  startX: number;
  startY: number;
  active: boolean;
  x: number;
  y: number;
  /** 当前悬停的目标文件夹（绝对路径） */
  target: string | null;
}

/** 左栏文件树：行高 28px，当前文件整行浅灰底加粗 */
export function FileTree() {
  const folder = useApp((s) => s.folder);
  const tree = useApp((s) => s.tree);
  const expanded = useApp((s) => s.expanded);
  const filePath = useApp((s) => s.filePath);
  const renaming = useApp((s) => s.renaming);
  const nodes = useMemo(() => buildTree(tree ?? []), [tree]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const closeMenu = useCallback(() => setMenu(null), []);

  // 当前文件滚到可见（只滚一次：等它在树里出现就滚，之后用户自己滚动不再拉回来）
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!filePath || scrolledFor.current === filePath) return;
    const row = document.querySelector<HTMLElement>('.file-tree .tree-row.current');
    if (row) {
      scrolledFor.current = filePath;
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [filePath, tree, expanded]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-drop-dir]');
      let target = el?.dataset.dropDir ?? null;
      // 不能拖进自己、自己的子文件夹，或原来所在的文件夹
      if (target && (target === d.from || target.startsWith(`${d.from}/`) || target.startsWith(`${d.from}\\`) || target === dirname(d.from))) {
        target = null;
      }
      const next = { ...d, active: true, x: e.clientX, y: e.clientY, target };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d?.active) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      setDrag(null);
      if (d.target) void moveEntry(d.from, d.target);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  if (!folder) return null;
  const abs = (rel: string) => (rel ? resolvePath(folder, rel) : folder);

  const openMenu = (e: ReactMouseEvent, node: Node | null) => {
    e.preventDefault();
    e.stopPropagation();
    const dir = node ? (node.dir ? abs(node.rel) : dirname(abs(node.rel))) : folder;
    const items: MenuItem[] = [
      { label: t.newNote, onSelect: () => void newNote(dir) },
      { label: t.newFolder, onSelect: () => void newFolder(dir) },
    ];
    if (node) {
      const path = abs(node.rel);
      items.push(
        'separator',
        { label: t.rename, hint: 'F2', onSelect: () => useApp.getState().setRenaming(path) },
        { label: t.revealInDir, onSelect: () => void deps.backend.revealInDir(path) },
        'separator',
        { label: t.moveToTrash, hint: isMac ? '⌘⌫' : 'Delete', onSelect: () => void trashEntry(path) },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const activate = (node: Node) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (node.dir) useApp.getState().setExpanded(node.rel, !expanded[node.rel]);
    else void openPath(abs(node.rel));
  };

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, node: Node) => {
    if (e.target !== e.currentTarget) return;
    const rows = [...(e.currentTarget.closest('.file-tree')?.querySelectorAll<HTMLElement>('.tree-row') ?? [])];
    const i = rows.indexOf(e.currentTarget);
    const path = abs(node.rel);
    if (e.key === 'ArrowDown') rows[i + 1]?.focus();
    else if (e.key === 'ArrowUp') rows[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && node.dir) useApp.getState().setExpanded(node.rel, true);
    else if (e.key === 'ArrowLeft' && node.dir) useApp.getState().setExpanded(node.rel, false);
    else if (e.key === 'Enter') activate(node);
    else if (e.key === 'F2') useApp.getState().setRenaming(path);
    else if (e.key === 'Delete' || (e.key === 'Backspace' && (isMac ? e.metaKey : e.ctrlKey))) void trashEntry(path);
    else return;
    e.preventDefault();
  };

  // ---------- 拖动到别的文件夹（鼠标事件实现：Windows 上 Tauri 接管了 HTML5 拖放） ----------
  const onRowMouseDown = (e: ReactMouseEvent, node: Node) => {
    if (e.button !== 0 || renaming) return;
    const d: Drag = {
      from: abs(node.rel),
      name: node.name,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      x: e.clientX,
      y: e.clientY,
      target: null,
    };
    dragRef.current = d;
  };

  const renderNode = (node: Node, depth: number): ReactNode => {
    const path = abs(node.rel);
    const open = !!expanded[node.rel];
    const current = !node.dir && path === filePath;
    const isRenaming = renaming === path;
    const dropDir = node.dir ? path : dirname(path);
    return (
      <div key={node.rel} role="none">
        <div
          role="treeitem"
          aria-expanded={node.dir ? open : undefined}
          aria-selected={current}
          tabIndex={0}
          className={`tree-row${node.dir ? ' tree-dir' : ''}${current ? ' current' : ''}${drag?.target === dropDir && node.dir ? ' drop-target' : ''}`}
          style={{ paddingLeft: 8 + depth * ROW_INDENT }}
          data-drop-dir={dropDir}
          title={node.rel}
          onClick={() => !isRenaming && activate(node)}
          onMouseDown={(e) => onRowMouseDown(e, node)}
          onContextMenu={(e) => openMenu(e, node)}
          onKeyDown={(e) => onRowKey(e, node)}
        >
          {node.dir && (
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" className="tree-chevron">
              <path d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} />
            </svg>
          )}
          {isRenaming ? <RenameInput path={path} name={node.name} /> : <span className="tree-name">{node.name}</span>}
        </div>
        {node.dir && open && (
          <div role="group">{node.children.map((c) => renderNode(c, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <nav
      className={`file-tree${drag?.target === folder ? ' drop-root' : ''}`}
      aria-label={t.files}
      role="tree"
      data-drop-dir={folder}
      onContextMenu={(e) => openMenu(e, null)}
    >
      {nodes.map((n) => renderNode(n, 0))}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      {drag?.active && (
        <div className="tree-drag-ghost" style={{ left: drag.x + 12, top: drag.y + 8 }}>
          {drag.name}
        </div>
      )}
    </nav>
  );
}

/** 行内改名：↵ 确认，Esc 取消，失焦确认；文件名默认只选中扩展名前面的部分 */
function RenameInput({ path, name }: { path: string; name: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = name.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [name]);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    void renameEntry(path, ref.current?.value ?? name);
  };
  return (
    <input
      ref={ref}
      className="tree-rename"
      defaultValue={name}
      aria-label={`${t.rename} ${basename(path)}`}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') {
          done.current = true;
          useApp.getState().setRenaming(null);
        }
      }}
      onBlur={commit}
    />
  );
}
