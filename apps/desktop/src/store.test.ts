import { beforeEach, describe, expect, it } from 'vitest';
import { activeThemeId, defaultSettings, editorKind, sanitizeSettings, useApp } from './store';

describe('sanitizeSettings', () => {
  it('空值和垃圾数据回到默认值', () => {
    expect(sanitizeSettings(undefined)).toEqual(defaultSettings);
    expect(sanitizeSettings({ edition: 'huge', themePref: { theme: 'neon', followSystem: 'yes' } })).toEqual(
      defaultSettings,
    );
  });

  it('原文和预览不能都关', () => {
    expect(sanitizeSettings({ showSource: false, showPreview: false })).toMatchObject({ showSource: true, showPreview: false });
  });

  it('保留合法值', () => {
    const s = sanitizeSettings({ edition: 'simple', showPreview: false, soloSource: 'plain', themePref: { theme: 'signal' } });
    expect(s.edition).toBe('simple');
    expect(s.showPreview).toBe(false);
    expect(s.soloSource).toBe('plain');
    expect(s.themePref.theme).toBe('signal');
    expect(s.themePref.dark).toBe('graphite');
  });

  it('界面语言默认英文，跟随系统要用户自己选', () => {
    expect(defaultSettings.language).toBe('en');
    expect(sanitizeSettings({ language: 'system' }).language).toBe('system');
    expect(sanitizeSettings({ language: 'zh-CN' }).language).toBe('zh-CN');
    expect(sanitizeSettings({ language: 'fr' }).language).toBe('en');
  });

  it('旧版主题换成新主题', () => {
    const s = sanitizeSettings({ themePref: { followSystem: true, theme: 'xuan', light: 'celadon', dark: 'ink' } });
    expect(s.themePref).toEqual({ followSystem: true, theme: 'frost', light: 'frost', dark: 'graphite' });
  });

  it('旧版图片设置没有"加载远程图片"，默认打开；关掉的能保留', () => {
    const old = sanitizeSettings({ image: { save: 'none', template: './img/{filename}.png', upload: 'none' } });
    expect(old.image.remote).toBe(true);
    expect(old.image.save).toBe('none');
    expect(sanitizeSettings({ image: { remote: false } }).image.remote).toBe(false);
    expect(sanitizeSettings({ image: { remote: 'no' } }).image.remote).toBe(true);
  });

  it('下标写法默认关闭，打开的能保留', () => {
    expect(sanitizeSettings({}).subscript).toBe(false);
    expect(sanitizeSettings({ subscript: true }).subscript).toBe(true);
    expect(sanitizeSettings({ subscript: 'yes' }).subscript).toBe(false);
  });
});

describe('activeThemeId', () => {
  const pref = { followSystem: true, theme: 'signal', light: 'frost', dark: 'graphite' } as const;
  it('跟随系统', () => {
    expect(activeThemeId(pref, false)).toBe('frost');
    expect(activeThemeId(pref, true)).toBe('graphite');
  });
  it('固定主题', () => {
    expect(activeThemeId({ ...pref, followSystem: false }, true)).toBe('signal');
  });
});

describe('useApp', () => {
  beforeEach(() => useApp.setState({ ...defaultSettings, systemDark: false }));

  it('切换版本', () => {
    useApp.getState().toggleEdition();
    expect(useApp.getState().edition).toBe('simple');
  });

  it('开关原文和预览：关掉唯一开着的那个时换成另一个', () => {
    const s = () => useApp.getState();
    expect(editorKind(s())).toBe('source');
    s().togglePreview();
    expect([s().showSource, s().showPreview]).toEqual([true, false]);
    expect(editorKind(s())).toBe('live');
    s().toggleSource();
    expect([s().showSource, s().showPreview]).toEqual([false, true]);
    expect(editorKind(s())).toBe('wysiwyg');
    s().toggleSource();
    expect([s().showSource, s().showPreview]).toEqual([true, true]);
    useApp.setState({ showPreview: false, soloSource: 'plain' });
    expect(editorKind(s())).toBe('source');
    // 文本文件不管开关，都用文本文件编辑器
    useApp.setState({ filePath: '/a/config.yaml' });
    expect(editorKind(s())).toBe('code');
    useApp.setState({ filePath: null });
  });

  it('跟随系统时切主题：从当前显示的主题往下切，并改成固定主题', () => {
    useApp.setState({
      systemDark: true,
      themePref: { followSystem: true, theme: 'frost', light: 'frost', dark: 'graphite' },
    });
    useApp.getState().cycleTheme();
    expect(useApp.getState().themePref).toMatchObject({ followSystem: false, theme: 'signal' });
  });
});

describe('文件树展开状态', () => {
  beforeEach(() => useApp.setState({ folder: null, expanded: {}, expandedFor: null }));

  it('同一个库保留，换库清空', () => {
    useApp.getState().setFolder('/v');
    useApp.getState().setExpanded('docs', true);
    useApp.getState().setFolder('/v');
    expect(useApp.getState().expanded).toEqual({ docs: true });
    useApp.getState().setFolder('/other');
    expect(useApp.getState().expanded).toEqual({});
  });

  it('设置校验：只保留 true', () => {
    expect(sanitizeSettings({ expanded: { a: true, b: false, c: 'x' }, expandedFor: '/v' })).toMatchObject({
      expanded: { a: true },
      expandedFor: '/v',
    });
  });
});
