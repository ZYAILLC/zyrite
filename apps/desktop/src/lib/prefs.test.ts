import { describe, expect, it } from 'vitest';
import { allowImage, defaultImagePrefs, isRemoteImage, sanitizeImagePrefs } from './prefs';

describe('加载远程图片', () => {
  it('默认打开', () => {
    expect(defaultImagePrefs.remote).toBe(true);
    expect(sanitizeImagePrefs(undefined).remote).toBe(true);
    expect(sanitizeImagePrefs({ remote: false }).remote).toBe(false);
  });

  it('只把 http、https 当网络图片', () => {
    expect(isRemoteImage('https://example.com/a.png')).toBe(true);
    expect(isRemoteImage('HTTP://example.com/a.png')).toBe(true);
    expect(isRemoteImage('data:image/png;base64,AAAA')).toBe(false);
    expect(isRemoteImage('blob:http://localhost/1')).toBe(false);
    expect(isRemoteImage('./assets/a.png')).toBe(false);
    expect(isRemoteImage('http.png')).toBe(false);
  });

  it('关掉后网络图片换成空地址，其他地址不变', () => {
    const off = { remote: false };
    expect(allowImage('https://example.com/a.png', off)).toBe('');
    expect(allowImage('data:image/png;base64,AAAA', off)).toBe('data:image/png;base64,AAAA');
    expect(allowImage('./a.png', off)).toBe('./a.png');
    expect(allowImage('https://example.com/a.png', { remote: true })).toBe('https://example.com/a.png');
  });
});
