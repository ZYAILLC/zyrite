import type { Paragraph } from 'mdast';
import { describe, expect, it } from 'vitest';
import { blockIndexAt, outline, parseMarkdown, splitBlocks, stringifyBlock } from './index';
import { loadCorpus } from './corpus';

const corpus = loadCorpus();

describe('splitBlocks', () => {
  it.each(corpus.map((c) => [c.name, c.source]))('%s：各块拼回去等于原文', (_name, source) => {
    const doc = splitBlocks(source);
    const joined = doc.blocks.map((b) => b.sepBefore + b.text).join('') + doc.trailing;
    expect(joined).toBe(source);
    for (const b of doc.blocks) expect(b.sepBefore.trim()).toBe('');
  });

  it('块区间和序号查找', () => {
    const doc = splitBlocks('# a\n\npara\n\n- x\n- y\n');
    expect(doc.blocks.map((b) => b.node.type)).toEqual(['heading', 'paragraph', 'list']);
    expect(blockIndexAt(doc.blocks, 0)).toBe(0);
    expect(blockIndexAt(doc.blocks, 6)).toBe(1);
    expect(blockIndexAt(doc.blocks, 100)).toBe(2);
  });
});

describe('detectStyle', () => {
  it('沿用文档里第一次出现的写法', () => {
    const s = splitBlocks('Title\n===\n\n* a\n\n_em_ __strong__\n\n~~~\nx\n~~~\n\n***\n').style;
    expect(s).toMatchObject({ setext: true, bullet: '*', emphasis: '_', strong: '_', fence: '~~~', rule: '***' });
  });

  it('CRLF', () => {
    expect(splitBlocks('a\r\nb\r\n').style.eol).toBe('\r\n');
    expect(splitBlocks('a\nb\r\n').style.eol).toBe('\n');
  });
});

describe('Obsidian 语法', () => {
  const inline = (md: string) => (parseMarkdown(md).children[0] as Paragraph).children;

  it('双链、嵌入、高亮、标签', () => {
    const nodes = inline('见 [[笔记#标题|别名]] 和 ![[图.png]]，==重点== #标签/子 结束');
    expect(nodes.map((n) => n.type)).toEqual([
      'text', 'wikiLink', 'text', 'wikiLink', 'text', 'highlight', 'text', 'tag', 'text',
    ]);
  });

  it('不是标签的情况', () => {
    const nodes = inline('C# 和 a#b 以及 #123');
    expect(nodes.every((n) => n.type === 'text')).toBe(true);
  });

  it('$ 两侧有空格时不是公式', () => {
    expect(inline('从 $5 到 $10').every((n) => n.type === 'text')).toBe(true);
    expect(inline('质能 $E=mc^2$ 方程').map((n) => n.type)).toEqual(['text', 'inlineMath', 'text']);
  });
});

describe('stringifyBlock 沿用原文风格', () => {
  it.each([
    '* a\n* b',
    '+ a\n+ b',
    '1) a\n2) b',
    '1. a\n1. b\n1. c',
    '-   wide\n-   indent',
    '_em_ and __strong__ and *em* and **strong**',
    'Setext\n======',
    '~~~~js\ncode\n~~~~',
    '    indented code',
    '* * *',
    'line  \nbreak',
    'line\\\nbreak',
    'see https://bare.link and <https://auto.link> and [x](https://y.z)',
    '[[笔记|别名]] ![[图.png]] ==高亮== #标签',
    '| a | b |\n| - | - |\n| 1 | 2 |',
    '- [ ] todo\n- [x] done',
    '$$\nx^2\n$$',
    'inline $x^2$ math',
  ])('%j', (md) => {
    const doc = splitBlocks(md);
    expect(doc.blocks).toHaveLength(1);
    const block = doc.blocks[0]!;
    expect(stringifyBlock(block.node, doc.style)).toBe(md);
  });
});

describe('outline', () => {
  it('只取顶层标题', () => {
    const items = outline(splitBlocks('# A\n\n> # not\n\n## B [[x|别名]]\n\nSetext\n---\n'));
    expect(items.map((i) => [i.depth, i.text])).toEqual([
      [1, 'A'],
      [2, 'B 别名'],
      [2, 'Setext'],
    ]);
  });
});

describe('相邻强调', () => {
  it('同符号相邻时换符号，解析结果不变', () => {
    const md = stringifyBlock(
      {
        type: 'paragraph',
        children: [
          { type: 'emphasis', children: [{ type: 'text', value: '新' }] },
          { type: 'strong', children: [{ type: 'text', value: '的' }] },
        ],
      },
      { ...splitBlocks('').style, emphasis: '_', strong: '_' },
    );
    const p = parseMarkdown(md).children[0] as Paragraph;
    expect(p.children.map((c) => c.type)).toEqual(['emphasis', 'strong']);
  });
});
