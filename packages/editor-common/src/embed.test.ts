// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { embedSection, renderEmbed, renderTableSource } from './dom';

const note = `---
title: x
---
# Top

intro

## Setup

step 1

### Detail

more

## Usage

\`\`\`sh
# not a heading
\`\`\`
`;

describe('embedSection', () => {
  it('去掉 frontmatter，不带标题时返回全文', () => {
    expect(embedSection(note, null).startsWith('# Top')).toBe(true);
  });

  it('只取那一节，包括下级标题，到同级标题为止', () => {
    expect(embedSection(note, 'setup')).toBe('## Setup\n\nstep 1\n\n### Detail\n\nmore\n');
  });

  it('代码块里的 # 不算标题；最后一节取到结尾', () => {
    expect(embedSection(note, 'Usage')).toBe('## Usage\n\n```sh\n# not a heading\n```\n');
  });

  it('找不到标题时返回全文', () => {
    expect(embedSection(note, 'nope').startsWith('# Top')).toBe(true);
  });
});

describe('renderEmbed', () => {
  it('图片：带宽高', () => {
    const el = document.createElement('span');
    const ok = renderEmbed(el, 'a.png|200', () => ({ kind: 'image', src: 'asset://a.png', alt: 'a.png', width: 200 }));
    expect(ok).toBe(true);
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('asset://a.png');
    expect(img.width).toBe(200);
    expect(el.className).toContain('zy-embed-image');
  });

  it('解析不了时返回 false，不改动元素', () => {
    const el = document.createElement('span');
    el.textContent = 'link';
    expect(renderEmbed(el, 'missing', () => null)).toBe(false);
    expect(renderEmbed(el, 'missing', undefined)).toBe(false);
    expect(el.textContent).toBe('link');
  });

  it('笔记：标题 + 异步渲染的内容', async () => {
    const el = document.createElement('span');
    renderEmbed(el, 'Note', () => ({ kind: 'note', title: 'Note', load: async () => '**hi**' }));
    expect(el.querySelector('.zy-embed-title')?.textContent).toBe('Note');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector('.zy-embed-body strong')?.textContent).toBe('hi');
  });
});

describe('renderTableSource', () => {
  it('单元格里的表情、上标', () => {
    const t = renderTableSource('| a |\n|---|\n| :zap: 10^8^ |\n');
    const td = t?.querySelector('td');
    expect(td?.innerHTML).toBe('<span class="emoji" title=":zap:">⚡</span> 10<sup>8</sup>');
  });
});
