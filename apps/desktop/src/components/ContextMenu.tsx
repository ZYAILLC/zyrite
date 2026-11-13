import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem = { label: string; hint?: string; onSelect: () => void } | 'separator';

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * 右键菜单。弹出层样式：细边框 + 轻阴影，6px 圆角；选中项整行浅灰底。
 * 点外面、Esc、窗口失焦都会关闭；↑↓ 选择，↵ 执行。
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const actions = items.filter((i) => i !== 'separator');
  const [active, setActive] = useState(0);

  // 贴着窗口边缘时往里收
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
    el.focus();
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const run = (i: number) => {
    const item = actions[i];
    if (!item) return;
    onClose();
    item.onSelect();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % actions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + actions.length) % actions.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(active);
    }
  };

  let index = -1;
  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item === 'separator') return <div key={`sep-${i}`} className="context-menu-sep" role="separator" />;
        const my = ++index;
        return (
          <div
            key={`${my}:${item.label}`}
            role="menuitem"
            className="context-menu-item"
            aria-selected={my === active}
            onMouseEnter={() => setActive(my)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(my)}
          >
            {item.label}
            {item.hint && <span className="context-menu-hint">{item.hint}</span>}
          </div>
        );
      })}
    </div>
  );
}
