// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { delimiterFor, parseDelimited, renderCsv, renderDelimitedTable } from './csv';

describe('parseDelimited（RFC 4180）', () => {
  it('普通字段、CRLF 换行、末尾换行', () => {
    expect(parseDelimited('a,b,c\r\n1,2,3\r\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('引号里的逗号、换行和转义的双引号', () => {
    expect(parseDelimited('name,note\n"Smith, J","line 1\nline 2"\n"say ""hi""",x')).toEqual([
      ['name', 'note'],
      ['Smith, J', 'line 1\nline 2'],
      ['say "hi"', 'x'],
    ]);
  });

  it('空字段、空的引号字段；空行跳过', () => {
    expect(parseDelimited('a,,c\n\n"",b,\n')).toEqual([
      ['a', '', 'c'],
      ['', 'b', ''],
    ]);
  });

  it('引号只在字段开头有特殊含义；没闭合的引号取到结尾', () => {
    expect(parseDelimited('5" disk,ok\n"open,end')).toEqual([['5" disk', 'ok'], ['open,end']]);
  });

  it('TSV 用制表符分隔，逗号是普通字符', () => {
    expect(parseDelimited('a\tb,c\n1\t"x\ty"', '\t')).toEqual([
      ['a', 'b,c'],
      ['1', 'x\ty'],
    ]);
  });

  it('空内容', () => {
    expect(parseDelimited('')).toEqual([]);
    expect(parseDelimited('\n\n')).toEqual([]);
  });

  it('语言名 → 分隔符', () => {
    expect(delimiterFor('csv')).toBe(',');
    expect(delimiterFor('TSV')).toBe('\t');
    expect(delimiterFor('js')).toBeNull();
    expect(delimiterFor(null)).toBeNull();
  });
});

describe('renderDelimitedTable', () => {
  it('第一行是表头；参差不齐的行补齐到最多的列数', () => {
    const table = renderDelimitedTable('h1,h2\n1\n2,3,4', ',');
    const rows = [...table.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => `${c.tagName}:${c.textContent}`));
    expect(rows).toEqual([
      ['TH:h1', 'TH:h2', 'TH:'],
      ['TD:1', 'TD:', 'TD:'],
      ['TD:2', 'TD:3', 'TD:4'],
    ]);
  });

  it('单元格内容是纯文本，不解析 HTML', () => {
    const table = renderDelimitedTable('a\n<img src=x onerror=alert(1)>', ',');
    expect(table.querySelector('img')).toBeNull();
    expect(table.querySelector('td')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('空内容显示一行提示，方便点开编辑', () => {
    const el = document.createElement('div');
    renderCsv(el, '', '\t');
    expect(el.querySelector('.zy-raw-hint')?.textContent).toBe('tsv');
  });
});
