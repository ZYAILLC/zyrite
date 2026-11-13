import { themeOrder, themes } from '@zyrite/themes';
import { locale, t } from '../i18n';
import { bindingOf, useApp } from '../store';
import { deps, newDoc, openDialog, openFolder, save, saveAs } from './document';
import type { CommandId } from './keymap';
import { acceptAll, focusChange } from './review';
import { newNote } from './vault';
import { dirname } from './paths';

/**
 * 所有命令：快捷键（components/useShortcuts）和 ⌘K 命令面板共用这一张表。
 * 有快捷键的命令 id 和 lib/keymap.ts 一致。
 */

function toggleFocusMode() {
  const s = useApp.getState();
  s.toggleFocusMode();
  s.setNotice({ text: s.focusMode ? t.focusModeOff : t.focusModeOn });
}

function toggleTypewriter() {
  const s = useApp.getState();
  s.toggleTypewriter();
  s.setNotice({ text: s.typewriter ? t.typewriterOff : t.typewriterOn });
}

/** 有快捷键的命令 */
export const handlers: Record<CommandId, () => void> = {
  'edition.toggle': () => useApp.getState().toggleEdition(),
  'view.preview': () => useApp.getState().togglePreview(),
  'view.source': () => useApp.getState().toggleSource(),
  'file.new': () => void newDoc(),
  'file.open': () => void openDialog(),
  'file.save': () => void save(),
  'file.saveAs': () => void saveAs(),
  'file.quickOpen': () => useApp.getState().openPalette('files'),
  'folder.open': () => void openFolder(),
  'find.open': () => useApp.getState().openFind(false),
  'find.replace': () => useApp.getState().openFind(true),
  'view.focusMode': toggleFocusMode,
  'palette.open': () => useApp.getState().openPalette('all'),
  'search.open': () => useApp.getState().openPalette('search'),
  'review.prev': () => focusChange(-1),
  'review.next': () => focusChange(1),
  'review.acceptAll': () => void acceptAll(),
  'settings.open': () => useApp.setState({ settingsTab: useApp.getState().settingsTab ? null : 'general' }),
};

/** 有快捷键的命令的名字（命令面板、设置 › 快捷键共用） */
export function commandLabel(id: CommandId): string {
  const labels: Record<CommandId, string> = {
    'edition.toggle': t.toggleEdition,
    'view.preview': t.togglePreview,
    'view.source': t.toggleSource,
    'file.new': t.cmdNewFile,
    'file.open': t.cmdOpenFile,
    'file.save': t.save,
    'file.saveAs': t.saveAs,
    'file.quickOpen': t.quickOpen,
    'folder.open': t.cmdOpenFolder,
    'find.open': t.find,
    'find.replace': t.replace,
    'view.focusMode': t.cmdFocusMode,
    'palette.open': t.cmdPalette,
    'search.open': t.cmdSearch,
    'review.prev': t.cmdReviewPrev,
    'review.next': t.cmdReviewNext,
    'review.acceptAll': t.cmdReviewAcceptAll,
    'settings.open': t.settings,
  };
  return labels[id];
}

export interface Command {
  id: string;
  label: string;
  /** 快捷键（keymap 写法），显示用 */
  binding?: string;
  run: () => void;
}

/** 命令面板里列出的命令（按当前状态动态生成：没打开库时不显示库相关的命令） */
export function listCommands(): Command[] {
  const s = useApp.getState();
  const bound = (id: CommandId, label: string): Command => ({
    id,
    label,
    binding: bindingOf(id) || undefined,
    run: handlers[id],
  });
  const list: Command[] = [
    bound('file.new', t.cmdNewFile),
    bound('file.open', t.cmdOpenFile),
    bound('folder.open', t.cmdOpenFolder),
    bound('file.save', t.save),
    bound('file.saveAs', t.saveAs),
    bound('file.quickOpen', t.quickOpen),
    bound('search.open', t.cmdSearch),
    bound('find.open', t.find),
    bound('find.replace', t.replace),
    bound('settings.open', t.settings),
    bound('edition.toggle', t.toggleEdition),
    bound('view.preview', t.togglePreview),
    bound('view.source', t.toggleSource),
    bound('view.focusMode', t.cmdFocusMode),
    { id: 'view.typewriter', label: t.cmdTypewriter, run: toggleTypewriter },
    { id: 'export.html', label: t.cmdExport('HTML'), run: () => void import('./export').then((m) => m.exportHtml()) },
    { id: 'export.pdf', label: t.cmdExport('PDF'), run: () => void import('./export').then((m) => m.exportPdf()) },
    { id: 'export.docx', label: t.cmdExport('Word'), run: () => void import('./export').then((m) => m.exportDocx()) },
    { id: 'theme.cycle', label: t.cycleTheme, run: () => useApp.getState().cycleTheme() },
    ...themeOrder.map((id) => ({
      id: `theme.${id}`,
      label: t.themeLabel(themes[id].name[locale]),
      run: () => {
        const pref = useApp.getState().themePref;
        useApp.setState({ themePref: { ...pref, followSystem: false, theme: id }, typoraTheme: null });
      },
    })),
  ];
  if (s.folder) {
    const dir = s.filePath && s.filePath.startsWith(s.folder) ? dirname(s.filePath) : s.folder;
    list.splice(1, 0, { id: 'note.new', label: t.newNote, run: () => void newNote(dir) });
  }
  if (s.filePath) {
    const path = s.filePath;
    list.push({ id: 'file.reveal', label: t.revealInDir, run: () => void deps.backend.revealInDir(path) });
  }
  return list;
}
