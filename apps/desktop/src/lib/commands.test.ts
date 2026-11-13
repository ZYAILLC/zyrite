import { beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../store';
import { handlers, listCommands } from './commands';
import { deps } from './document';
import { fakeBackend, resetStore } from './fakeBackend.testutil';
import { defaultKeymap } from './keymap';

beforeEach(() => {
  resetStore();
  deps.backend = fakeBackend().b;
});

describe('命令', () => {
  it('每个快捷键都有对应的处理', () => {
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(defaultKeymap).sort());
  });

  it('没打开库时没有库相关的命令；打开后有', () => {
    expect(listCommands().some((c) => c.id === 'note.new')).toBe(false);
    useApp.setState({ folder: '/v', filePath: '/v/a.md' });
    const ids = listCommands().map((c) => c.id);
    expect(ids).toContain('note.new');
    expect(ids).toContain('file.reveal');
    expect(ids).toContain('view.typewriter');
  });

  it('执行：主题、打字机模式、打开面板', () => {
    const cmd = (id: string) => listCommands().find((c) => c.id === id)!;
    cmd('theme.graphite').run();
    expect(useApp.getState().themePref).toMatchObject({ theme: 'graphite', followSystem: false });
    cmd('view.typewriter').run();
    expect(useApp.getState().typewriter).toBe(true);
    handlers['palette.open']();
    expect(useApp.getState().palette).toEqual({ mode: 'all', tag: undefined });
    handlers['search.open']();
    expect(useApp.getState().palette?.mode).toBe('search');
  });
});
