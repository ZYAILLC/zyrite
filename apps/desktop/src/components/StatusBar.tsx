import { themes } from '@zyrite/themes';
import { useEffect, useMemo } from 'react';
import { locale, t } from '../i18n';
import { countWords } from '../lib/wordCount';
import { activeThemeId, useApp, useBinding } from '../store';

/** 状态栏 30px：左边原文、预览开关和字数，右边主题 */
export function StatusBar() {
  const showSource = useApp((s) => s.showSource);
  const showPreview = useApp((s) => s.showPreview);
  const toggleSource = useApp((s) => s.toggleSource);
  const togglePreview = useApp((s) => s.togglePreview);
  const cycleTheme = useApp((s) => s.cycleTheme);
  const text = useApp((s) => s.text);
  const theme = useApp((s) => themes[activeThemeId(s.themePref, s.systemDark)]);
  const words = useMemo(() => countWords(text).toLocaleString(locale), [text]);
  const sourceKey = useBinding('view.source');
  const previewKey = useBinding('view.preview');
  const typoraTheme = useApp((s) => s.typoraTheme);
  const themeName = typoraTheme ?? theme.name[locale];
  const notice = useApp((s) => s.notice);
  const setNotice = useApp((s) => s.setNotice);

  // 提示几秒后消失；出错的多留一会儿
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.durationMs ?? (notice.error ? 8000 : 2500));
    return () => clearTimeout(timer);
  }, [notice, setNotice]);

  return (
    <footer className="statusbar">
      {/* 开着的加粗；按下时不抢焦点，切换后光标还在原来的块 */}
      <span className="pane-toggles">
        <button
          type="button"
          aria-pressed={showSource}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleSource}
          title={`${t.toggleSource} ${sourceKey}`}
        >
          {t.paneSource}
        </button>
        <button
          type="button"
          aria-pressed={showPreview}
          onMouseDown={(e) => e.preventDefault()}
          onClick={togglePreview}
          title={`${t.togglePreview} ${previewKey}`}
        >
          {t.panePreview}
        </button>
      </span>
      <span>{t.wordCount(words)}</span>
      <span role="status" className={notice?.error ? 'status-error' : undefined}>
        {notice?.text}
      </span>
      <button type="button" className="push" onClick={cycleTheme} title={t.cycleTheme}>
        {t.themeLabel(themeName)}
      </button>
    </footer>
  );
}
