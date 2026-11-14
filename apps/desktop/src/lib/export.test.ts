import { beforeEach, describe, expect, it } from 'vitest';
import { locale, t } from '../i18n';
import { useApp } from '../store';
import { deps } from './document';
import { buildDocx, buildHtml, exportPdf } from './export';
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

describe('导出 PDF', () => {
  beforeEach(() => {
    useApp.setState({ filePath: '/v/a.md', text: '# 标题\n\n正文' });
    fake.state.savePick = '/out/a.pdf';
  });

  it('选好位置后直接生成：带纸张、边距，页眉页脚在打印容器里，完成后移除容器', async () => {
    useApp.setState({ exportPrefs: { paper: 'Letter', margin: 15, header: 'title', footer: 'date' } });
    await exportPdf();
    expect(fake.state.pdfs).toHaveLength(1);
    const call = fake.state.pdfs[0]!;
    expect(call.path).toBe('/out/a.pdf');
    expect(call.page).toEqual({ paper: 'Letter', marginMm: 15, header: null, footer: null });
    expect(call.printing).toBe(true);
    expect(call.html).toContain('<h1>标题</h1>');
    expect(call.html).toContain('<div class="zy-print-head">a</div>');
    expect(call.html).toContain('zy-print-foot');
    expect(fake.state.printed).toBe(0);
    expect(document.getElementById('zy-print')).toBeNull();
    expect(document.getElementById('zy-print-style')).toBeNull();
    expect(document.documentElement.classList.contains('zy-printing')).toBe(false);
    expect(useApp.getState().notice).toEqual({ text: t.exported('PDF', 'a.pdf'), error: false });
  });

  it('后端能在每页画页眉页脚时交给它，页面里不放', async () => {
    fake.state.pdfHeaderFooter = true;
    useApp.setState({ exportPrefs: { paper: 'A4', margin: 20, header: 'title', footer: 'date' } });
    await exportPdf();
    const call = fake.state.pdfs[0]!;
    expect(call.page).toEqual({ paper: 'A4', marginMm: 20, header: 'a', footer: new Date().toLocaleDateString(locale) });
    expect(call.html).not.toContain('zy-print-head');
    expect(call.html).not.toContain('zy-print-foot');
    expect(call.html).toContain('<h1>标题</h1>');
  });

  it('没开页眉页脚时两边都不放', async () => {
    fake.state.pdfHeaderFooter = true;
    await exportPdf();
    expect(fake.state.pdfs[0]!.page).toMatchObject({ header: null, footer: null });
  });

  it('取消保存对话框时什么都不做', async () => {
    fake.state.savePick = null;
    await exportPdf();
    expect(fake.state.pdfs).toHaveLength(0);
    expect(fake.state.printed).toBe(0);
    expect(useApp.getState().notice).toBeNull();
  });

  it('生成失败：提示错误，也移除打印容器', async () => {
    fake.state.pdfAnswer = 'boom';
    await exportPdf();
    expect(useApp.getState().notice).toEqual({ text: t.exportFailed('PDF', 'boom'), error: true });
    expect(document.getElementById('zy-print')).toBeNull();
    expect(document.documentElement.classList.contains('zy-printing')).toBe(false);
  });

  it('WebView 不支持直接导出时退回打印对话框', async () => {
    fake.state.pdfAnswer = false;
    await exportPdf();
    expect(fake.state.pdfs).toHaveLength(1);
    expect(fake.state.printed).toBe(1);
    expect(useApp.getState().notice).toBeNull();
    // 打印对话框关闭后才移除容器
    expect(document.getElementById('zy-print')).not.toBeNull();
    window.dispatchEvent(new Event('afterprint'));
    expect(document.getElementById('zy-print')).toBeNull();
  });

  it('后端没有直接导出（浏览器调试）时用打印对话框，不弹保存对话框', async () => {
    delete fake.b.exportPdf;
    fake.state.savePick = null;
    await exportPdf();
    expect(fake.state.printed).toBe(1);
    expect(document.getElementById('zy-print')?.innerHTML).toContain('<h1>标题</h1>');
    window.dispatchEvent(new Event('afterprint'));
    expect(document.getElementById('zy-print')).toBeNull();
  });
});
