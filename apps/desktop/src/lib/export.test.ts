import { beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../store';
import { deps } from './document';
import { buildDocx, buildHtml } from './export';
import { fakeBackend, resetStore } from './fakeBackend.testutil';

let fake: ReturnType<typeof fakeBackend>;

beforeEach(() => {
  resetStore();
  fake = fakeBackend();
  deps.backend = fake.b;
});

const MD = `---
title: x
---
# 标题

**粗**和*斜*，[链接](https://z-y.ai)，[[笔记|别名]]，#标签，==高亮==，\`code\`[^1]

![图](img/a.png)

1. 一
   - [x] 子

> 引用

| a | b |
|:-:|--:|
| 1 | 2 |

\`\`\`js
let a = 1;
\`\`\`

---

[^1]: 脚注
`;

describe('导出 HTML', () => {
  it('单文件：本地图片内嵌、带主题样式', async () => {
    fake.state.binaries.set('/v/img/a.png', 'iVBORw0KGgo=');
    document.documentElement.style.setProperty('--z-bg', '#ffffff');
    const html = await buildHtml({ markdown: MD, filePath: '/v/a.md', title: 'a' });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<title>a</title>');
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).toContain('--z-bg:#ffffff');
    expect(html).toContain('<div id="write" class="zy-doc">');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).not.toContain('title: x');
  });
});

describe('导出 Word 的文档结构', () => {
  it('标题、行内样式、列表、引用、表格、代码、脚注', async () => {
    useApp.setState({ exportPrefs: { paper: 'Letter', margin: 25, header: 'title', footer: 'none' } });
    const doc = await buildDocx({ markdown: MD, filePath: '/v/a.md', title: 'a' });
    expect(doc.page).toEqual({ paper: 'Letter', marginMm: 25, header: 'a', footer: null });
    const types = doc.blocks.map((b) => b.t);
    expect(types).toEqual(['heading', 'para', 'para', 'list', 'quote', 'table', 'code', 'rule', 'rule', 'para']);
    const para = doc.blocks[1] as { inlines: { t: string; text?: string; marks?: Record<string, boolean>; link?: string }[] };
    expect(para.inlines.find((i) => i.text === '粗')?.marks?.bold).toBe(true);
    expect(para.inlines.find((i) => i.text === '链接')?.link).toBe('https://z-y.ai');
    expect(para.inlines.find((i) => i.text === '别名')).toBeTruthy();
    expect(para.inlines.find((i) => i.text === '高亮')?.marks?.mark).toBe(true);
    expect(para.inlines.find((i) => i.text === '[1]')?.marks?.sup).toBe(true);
    // jsdom 里没有 canvas，图片转不了 PNG，退回成文字
    expect(doc.blocks[2]).toMatchObject({ t: 'para' });
    const list = doc.blocks[3] as { ordered: boolean; items: { blocks: { t: string; items?: { checked: boolean }[] }[] }[] };
    expect(list.ordered).toBe(true);
    expect(list.items[0]!.blocks[1]!.items![0]!.checked).toBe(true);
    expect(doc.blocks[5]).toMatchObject({ t: 'table', align: ['center', 'right'] });
    expect(doc.blocks[6]).toEqual({ t: 'code', lang: 'js', text: 'let a = 1;' });
    expect((doc.blocks[9] as { inlines: { text: string }[] }).inlines[0]!.text).toBe('[1] ');
  });
});
