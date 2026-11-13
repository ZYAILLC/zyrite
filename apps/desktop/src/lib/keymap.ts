/**
 * 快捷键表。绑定写法类似 CodeMirror：`Mod-Shift-e`，Mod 在 macOS 上是 ⌘，其他平台是 Ctrl。
 * 第一版只有默认值；以后要在设置里可改，所以所有快捷键都从这里走。
 */
export type CommandId =
  | 'edition.toggle'
  | 'view.preview'
  | 'view.source'
  | 'file.new'
  | 'file.open'
  | 'file.save'
  | 'file.saveAs'
  | 'file.quickOpen'
  | 'folder.open'
  | 'find.open'
  | 'find.replace'
  | 'view.focusMode'
  | 'palette.open'
  | 'search.open'
  | 'review.prev'
  | 'review.next'
  | 'review.acceptAll'
  | 'settings.open';

export const defaultKeymap: Record<CommandId, string> = {
  'edition.toggle': 'Mod-Shift-e',
  'view.preview': 'Mod-/',
  'view.source': 'Mod-Shift-/',
  'file.new': 'Mod-n',
  'file.open': 'Mod-o',
  'file.save': 'Mod-s',
  'file.saveAs': 'Mod-Shift-s',
  'file.quickOpen': 'Mod-p',
  'folder.open': 'Mod-Shift-o',
  'find.open': 'Mod-f',
  'find.replace': 'Mod-Alt-f',
  'view.focusMode': 'Mod-Shift-.',
  'palette.open': 'Mod-k',
  'search.open': 'Mod-Shift-f',
  // 审阅时才生效（components/useShortcuts）
  'review.prev': 'Alt-ArrowUp',
  'review.next': 'Alt-ArrowDown',
  'review.acceptAll': 'Mod-Shift-Enter',
  'settings.open': 'Mod-,',
};

/** 标点键的物理键位：按住 Shift 或在非美式布局下 e.key 会变（例如 ⇧. 是 >），按键位匹配 */
const PUNCT_CODE: Record<string, string> = {
  '.': 'Period',
  ',': 'Comma',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote',
  '\\': 'Backslash',
};

interface Binding {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  key: string;
}

function parse(binding: string): Binding {
  const parts = binding.split(/-(?!$)/);
  const key = (parts.pop() ?? '').toLowerCase();
  const has = (m: string) => parts.includes(m);
  return { mod: has('Mod'), shift: has('Shift'), alt: has('Alt'), ctrl: has('Ctrl'), key };
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

export function matches(binding: string, e: KeyLike, mac: boolean): boolean {
  const b = parse(binding);
  const wantMeta = mac && b.mod;
  const wantCtrl = (!mac && b.mod) || b.ctrl;
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.shiftKey !== b.shift || e.altKey !== b.alt) {
    return false;
  }
  if (e.key.toLowerCase() === b.key) return true;
  // 非拉丁键盘布局、按住 Shift / Option 时 e.key 会变，退回到物理键位
  if (/^[a-z]$/.test(b.key)) return e.code === `Key${b.key.toUpperCase()}`;
  return PUNCT_CODE[b.key] !== undefined && e.code === PUNCT_CODE[b.key];
}

export function findCommand(e: KeyLike, mac: boolean, keymap = defaultKeymap): CommandId | undefined {
  return (Object.keys(keymap) as CommandId[]).find((id) => keymap[id] !== '' && matches(keymap[id], e, mac));
}

/** 显示用：mac 上 `⌘⇧E`，其他平台 `Ctrl+Shift+E` */
export function formatBinding(binding: string, mac: boolean): string {
  const b = parse(binding);
  const named: Record<string, string> = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', enter: '↵' };
  const key = named[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key);
  if (mac) {
    return `${b.ctrl ? '⌃' : ''}${b.alt ? '⌥' : ''}${b.shift ? '⇧' : ''}${b.mod ? '⌘' : ''}${key}`;
  }
  const mods = [b.mod || b.ctrl ? 'Ctrl' : '', b.alt ? 'Alt' : '', b.shift ? 'Shift' : ''].filter(Boolean);
  return [...mods, key].join('+');
}

const CODE_PUNCT = Object.fromEntries(Object.entries(PUNCT_CODE).map(([k, v]) => [v, k]));
const NAMED_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab', 'Space', 'Home', 'End', 'PageUp', 'PageDown']);

/** 设置里录快捷键：按键 → keymap 写法；只按了修饰键、或没带修饰键的普通键返回 null */
export function bindingFromEvent(e: KeyLike, mac: boolean): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Process'].includes(e.key)) return null;
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_PUNCT[e.code]) key = CODE_PUNCT[e.code]!;
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key;
  else if (NAMED_KEYS.has(e.key)) key = e.key;
  else if (e.key === ' ') key = 'Space';
  else return null;
  const mod = mac ? e.metaKey : e.ctrlKey;
  const ctrl = mac && e.ctrlKey;
  if (!mod && !ctrl && !e.altKey && !/^F\d/.test(key)) return null;
  return [mod && 'Mod', ctrl && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('-');
}
