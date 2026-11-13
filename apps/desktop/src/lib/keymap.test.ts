import { describe, expect, it } from 'vitest';
import { bindingFromEvent, defaultKeymap, findCommand, formatBinding, matches } from './keymap';

const ev = (key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}, code = '') => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('matches', () => {
  it('Mod 在 mac 上是 ⌘，其他平台是 Ctrl', () => {
    expect(matches('Mod-/', ev('/', { metaKey: true }), true)).toBe(true);
    expect(matches('Mod-/', ev('/', { ctrlKey: true }), true)).toBe(false);
    expect(matches('Mod-/', ev('/', { ctrlKey: true }), false)).toBe(true);
    expect(matches('Mod-/', ev('/', { metaKey: true }), false)).toBe(false);
  });

  it('修饰键必须完全一致', () => {
    expect(matches('Mod-Shift-e', ev('E', { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(matches('Mod-Shift-e', ev('e', { metaKey: true }), true)).toBe(false);
    expect(matches('Mod-/', ev('/', { metaKey: true, altKey: true }), true)).toBe(false);
  });

  it('标点键按住 Shift 时按物理键位匹配', () => {
    expect(matches('Mod-Shift-.', ev('>', { metaKey: true, shiftKey: true }, 'Period'), true)).toBe(true);
    expect(matches('Mod-Shift-.', ev('>', { metaKey: true, shiftKey: true }, 'Comma'), true)).toBe(false);
    // Option+F 在 mac 上打出 ƒ
    expect(matches('Mod-Alt-f', ev('ƒ', { metaKey: true, altKey: true }, 'KeyF'), true)).toBe(true);
  });

  it('非拉丁布局按物理键位匹配', () => {
    expect(matches('Mod-Shift-e', ev('У', { ctrlKey: true, shiftKey: true }, 'KeyE'), false)).toBe(true);
  });
});

describe('findCommand', () => {
  it('找到对应命令', () => {
    expect(findCommand(ev('E', { ctrlKey: true, shiftKey: true }), false)).toBe('edition.toggle');
    expect(findCommand(ev('/', { metaKey: true }), true)).toBe('view.preview');
    expect(findCommand(ev('?', { metaKey: true, shiftKey: true }, 'Slash'), true)).toBe('view.source');
    expect(findCommand(ev('x', { metaKey: true }), true)).toBeUndefined();
  });
});

describe('formatBinding', () => {
  it('按平台显示', () => {
    expect(formatBinding('Mod-Shift-e', true)).toBe('⇧⌘E');
    expect(formatBinding('Mod-Shift-e', false)).toBe('Ctrl+Shift+E');
    expect(formatBinding('Mod-/', false)).toBe('Ctrl+/');
    expect(formatBinding('Alt-ArrowUp', true)).toBe('⌥↑');
    expect(formatBinding('Mod-Shift-Enter', true)).toBe('⇧⌘↵');
  });
});

describe('录快捷键', () => {
  it('按键 → 写法，录下来的能匹配回去', () => {
    const e = ev('E', { metaKey: true, shiftKey: true }, 'KeyE');
    const b = bindingFromEvent(e, true);
    expect(b).toBe('Mod-Shift-e');
    expect(matches(b!, e, true)).toBe(true);
    expect(bindingFromEvent(ev('>', { ctrlKey: true, shiftKey: true }, 'Period'), false)).toBe('Mod-Shift-.');
    expect(bindingFromEvent(ev('ArrowUp', { altKey: true }, 'ArrowUp'), false)).toBe('Alt-ArrowUp');
    expect(bindingFromEvent(ev('F5', {}, 'F5'), false)).toBe('F5');
  });

  it('只按修饰键、或没带修饰键的普通键不算', () => {
    expect(bindingFromEvent(ev('Shift', { shiftKey: true }, 'ShiftLeft'), false)).toBeNull();
    expect(bindingFromEvent(ev('a', {}, 'KeyA'), false)).toBeNull();
  });

  it('去掉的快捷键不触发', () => {
    expect(findCommand(ev('s', { ctrlKey: true }, 'KeyS'), false, { ...defaultKeymapForTest(), 'file.save': '' })).toBeUndefined();
  });
});

function defaultKeymapForTest() {
  return Object.fromEntries(Object.entries(defaultKeymap)) as typeof defaultKeymap;
}
