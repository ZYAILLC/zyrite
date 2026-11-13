import { getCurrentWindow } from '@tauri-apps/api/window';
import { type Theme, themes, themeToCssVars } from '@zyrite/themes';
import { useEffect } from 'react';
import { isTauri } from '../lib/platform';
import { applyTyporaTheme, luminanceOf } from '../lib/typoraTheme';
import { activeThemeId, useApp } from '../store';

/** 把当前主题写到根元素的 CSS 变量上，并让原生窗口（红绿灯、滚动条）跟着深浅色走 */
export function useTheme() {
  const pref = useApp((s) => s.themePref);
  const systemDark = useApp((s) => s.systemDark);
  const setSystemDark = useApp((s) => s.setSystemDark);
  const theme = themes[activeThemeId(pref, systemDark)];
  const fontSize = useApp((s) => s.fontSize);
  const lineWidth = useApp((s) => s.lineWidth);
  const lineHeight = useApp((s) => s.lineHeight);

  // 正文字号、行宽（正文字号、行宽、行高可调）
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--zy-font-size', `${fontSize}px`);
    root.style.setProperty('--zy-line-width', `${lineWidth}px`);
    root.style.setProperty('--zy-line-height', String(lineHeight));
  }, [fontSize, lineWidth, lineHeight]);

  // 跟随系统时窗口不强制深浅色，媒体查询拿到的就是系统值；固定主题时不关心系统值
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [setSystemDark]);

  // 内置主题；导入了 Typora 主题时，正文区用 Typora 主题，界面按它的背景和文字色调整
  const typoraTheme = useApp((s) => s.typoraTheme);
  useEffect(() => {
    const root = document.documentElement;
    let cancelled = false;
    const setVars = (base: Theme, extra: Record<string, string> = {}) => {
      for (const [k, v] of Object.entries({ ...themeToCssVars(base), ...extra })) root.style.setProperty(k, v);
      root.dataset.theme = base.id;
      root.style.colorScheme = base.dark ? 'dark' : 'light';
      if (isTauri) {
        getCurrentWindow()
          .setTheme(pref.followSystem && !typoraTheme ? null : base.dark ? 'dark' : 'light')
          .catch(() => {});
      }
    };
    setVars(theme);
    if (typoraTheme) {
      void applyTyporaTheme(typoraTheme)
        .then((r) => {
          if (cancelled || !r) return;
          const lum = luminanceOf(r.bg);
          const bg = lum === null ? (themes.frost.colors.bg as string) : r.bg;
          const dark = (lum ?? 1) < 0.4;
          const mix = (p: number) => `color-mix(in srgb, ${r.text} ${p}%, ${bg})`;
          // 侧栏也跟着 Typora 主题走，不用内置主题的深色侧栏
          setVars(themes[dark ? 'graphite' : 'frost'], {
            '--z-bg': bg,
            '--z-side': bg,
            '--z-text': r.text,
            '--z-muted': mix(62),
            '--z-hair': mix(14),
            '--z-sel': mix(10),
            '--z-code': mix(5),
            '--z-side-text': r.text,
            '--z-side-muted': mix(62),
            '--z-side-hair': mix(14),
            '--z-side-sel': mix(10),
          });
        })
        .catch(() => {});
    } else {
      void applyTyporaTheme(null);
    }
    return () => {
      cancelled = true;
    };
  }, [theme, pref.followSystem, typoraTheme]);
}
