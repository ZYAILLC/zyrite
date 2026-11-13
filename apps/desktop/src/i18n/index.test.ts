import { describe, expect, it } from 'vitest';
import { SETTINGS_VERSION, savedLanguageValue } from './index';

describe('savedLanguageValue', () => {
  it('没存过或存了无效值时默认英文', () => {
    expect(savedLanguageValue(undefined, 0)).toBe('en');
    expect(savedLanguageValue('fr', SETTINGS_VERSION)).toBe('en');
  });

  it('用户选的中文、英文保留', () => {
    expect(savedLanguageValue('zh-CN', 1)).toBe('zh-CN');
    expect(savedLanguageValue('en', SETTINGS_VERSION)).toBe('en');
  });

  it('旧版自动存下的跟随系统换成英文，新版用户选的跟随系统保留', () => {
    expect(savedLanguageValue('system', 1)).toBe('en');
    expect(savedLanguageValue('system', SETTINGS_VERSION)).toBe('system');
  });
});
