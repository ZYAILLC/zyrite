import { codeLanguage } from '@zyrite/editor-live';
import { themes } from '@zyrite/themes';
import { useEffect, useMemo, useState } from 'react';
import { locale, t } from '../i18n';
import { convertToUtf8, reopenWithEncoding } from '../lib/document';
import { basename, isMarkdownDoc } from '../lib/paths';
import { ContextMenu, type MenuItem } from './ContextMenu';
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
  const filePath = useApp((s) => s.filePath);
  const readOnly = useApp((s) => s.readOnly);
  const markdown = isMarkdownDoc(filePath);
  // Markdown 显示字数；文本文件显示语言和行数（没有原文、预览开关）
  const count = useMemo(
    () => (markdown ? t.wordCount(countWords(text).toLocaleString(locale)) : t.lineCount(lineCount(text).toLocaleString(locale))),
    [text, markdown],
  );
  const language = markdown || !filePath ? null : languageLabel(codeLanguage(basename(filePath)).name);
  const encoding = useApp((s) => s.encoding) ?? 'UTF-8';
  // 编码：不是 UTF-8 的文件、以及所有文本文件显示（Markdown 一般是 UTF-8，不占地方）
  const showEncoding = !!filePath && (encoding !== 'UTF-8' || !markdown);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuItems = (): MenuItem[] => [
    ...ENCODINGS.filter((e) => e !== encoding).map((e) => ({
      label: t.reopenWith(e),
      onSelect: () => void reopenWithEncoding(e),
    })),
    ...(encoding !== 'UTF-8' ? (['separator', { label: t.convertToUtf8, onSelect: () => void convertToUtf8() }] as MenuItem[]) : []),
  ];
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
    <>
      <footer className="statusbar">
        {/* 原文、预览开关：开着的加粗；按下时不抢焦点，切换后光标还在原来的块。文本文件换成语言名 */}
        {language ? (
          <span>
            {language}
            {readOnly && ` · ${t.readOnly}`}
          </span>
        ) : (
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
        )}
        <span>{count}</span>
        {showEncoding && (
          <button
            type="button"
            title={t.encodingMenu}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.top });
            }}
          >
            {encoding}
          </button>
        )}
        <span role="status" className={notice?.error ? 'status-error' : undefined}>
          {notice?.text}
        </span>
        <button type="button" className="push" onClick={cycleTheme} title={t.cycleTheme}>
          {t.themeLabel(themeName)}
        </button>
      </footer>
      {/* 菜单放在状态栏外面，不继承状态栏的等宽字体 */}
      {menu && <ContextMenu x={menu.x} y={menu.y} above items={menuItems()} onClose={() => setMenu(null)} />}
    </>
  );
}

/** 行数：末尾的换行不算一行 */
function lineCount(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < text.length - 1; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** 编码菜单里可选的编码（中文、日文、韩文和西欧的常见旧编码） */
const ENCODINGS = ['UTF-8', 'GB18030', 'GBK', 'Big5', 'Shift_JIS', 'EUC-JP', 'EUC-KR', 'windows-1252', 'UTF-16LE', 'UTF-16BE'];

/** 语言名：YAML、JSON 等照原样，纯文本和日志按界面语言 */
function languageLabel(name: string): string {
  return name === 'Plain Text' ? t.plainText : name === 'Log' ? t.logFile : name;
}
