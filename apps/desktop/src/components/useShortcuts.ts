import { useEffect } from 'react';
import { handlers } from '../lib/commands';
import { findCommand } from '../lib/keymap';
import { isMac } from '../lib/platform';
import { effectiveKeymap } from '../lib/prefs';
import { useApp } from '../store';

export function useShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      // 设置里正在录快捷键
      if ((document.activeElement as HTMLElement | null)?.dataset?.recording) return;
      const id = findCommand(e, isMac, effectiveKeymap(useApp.getState().keymap));
      if (!id) return;
      // 审阅快捷键只在有待审阅的改动时生效，否则 ⌥↑ 等留给编辑器（移动行）
      if (id.startsWith('review.') && !useApp.getState().review) return;
      e.preventDefault();
      handlers[id]();
    };
    // 捕获阶段：编辑器内的按键处理不会把应用级快捷键吞掉
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
