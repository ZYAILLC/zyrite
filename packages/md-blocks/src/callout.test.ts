import { describe, expect, it } from 'vitest';
import { calloutLabel, renderHtml } from './render';

describe('callout', () => {
  it('第一行拆成标题，类型名放在前面', () => {
    const html = renderHtml('> [!warning] Heads up\n> Body text.');
    expect(html).toContain('<blockquote data-callout="warning">');
    expect(html).toContain('<p class="callout-title"><span class="callout-mark">Warning</span> Heads up</p>');
    expect(html).toContain('<p>Body text.</p>');
  });

  it('没有标题时只显示类型名；类型不分大小写', () => {
    const html = renderHtml('> [!NOTE]\n> Only body');
    expect(html).toContain('data-callout="note"');
    expect(html).toContain('<p class="callout-title"><span class="callout-mark">Note</span></p>');
    expect(html).toContain('<p>Only body</p>');
  });

  it('标题里的行内格式保留，折叠标记不显示', () => {
    const html = renderHtml('> [!tip]- **Bold** title\n> body');
    expect(html).toContain('<span class="callout-mark">Tip</span> <strong>Bold</strong> title');
    expect(html).not.toContain('[!tip]');
  });

  it('普通引用不受影响', () => {
    expect(renderHtml('> just a quote')).toBe('<blockquote>\n<p>just a quote</p>\n</blockquote>');
  });

  it('类型名转成标题', () => {
    expect(calloutLabel('to-do')).toBe('To do');
    expect(calloutLabel('FAQ')).toBe('Faq');
  });
});
