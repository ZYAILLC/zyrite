import type { Nodes, Paragraph, PhrasingContent } from 'mdast';
import { afterEach, describe, expect, it } from 'vitest';
import { emojiByName, parseMarkdown, renderHtml, setParseOptions, splitBlocks, stringifyBlock } from './index';

/** 第一段的行内节点 */
const inline = (md: string): PhrasingContent[] => (parseMarkdown(md).children[0] as Paragraph).children;
const types = (md: string) => inline(md).map((n) => n.type);

/** 解析后整块重新序列化（模拟块被编辑过） */
const rewrite = (md: string) => {
  const doc = splitBlocks(md);
  return doc.blocks.map((b) => stringifyBlock(b.node, doc.style)).join('\n\n');
};

afterEach(() => setParseOptions({ subscript: false }));

describe('表情短代码', () => {
  it('认识的名字转成 emoji 节点，位置对应原文', () => {
    const md = 'Ship it :rocket: and :+1:';
    const nodes = inline(md);
    expect(nodes.map((n) => n.type)).toEqual(['text', 'emoji', 'text', 'emoji']);
    const rocket = nodes[1] as Nodes & { value: string };
    expect(rocket.value).toBe('rocket');
    expect(md.slice(rocket.position!.start.offset, rocket.position!.end.offset)).toBe(':rocket:');
    expect(emojiByName('rocket')).toBe('🚀');
    expect(emojiByName('nope')).toBeUndefined();
  });

  it('不认识的名字、时间、紧挨字母数字的不转', () => {
    expect(types(':nope: here')).toEqual(['text']);
    expect(types('at 12:30:45 sharp')).toEqual(['text']);
    expect(types('a:rocket:b')).toEqual(['text']);
    expect(types('x:rocket: y')).toEqual(['text']);
  });

  it('不认识的名字后面紧跟认识的也能找到', () => {
    expect(types(':nope: :rocket:')).toEqual(['text', 'emoji']);
    expect(types(':smile::smile:')).toEqual(['emoji', 'emoji']);
  });

  it('行内代码、代码块、链接地址里不转', () => {
    expect(types('`:rocket:`')).toEqual(['inlineCode']);
    expect(parseMarkdown('```\n:rocket:\n```').children[0]!.type).toBe('code');
    expect(renderHtml('see https://example.com/:rocket:/x')).not.toContain('class="emoji"');
    expect(renderHtml('[:rocket:](https://x.y/:rocket:)')).not.toContain('class="emoji"');
  });

  it('转义的冒号不转', () => {
    expect(types('\\:rocket: x')).toEqual(['text']);
  });

  it('渲染成表情字符，title 是短代码', () => {
    expect(renderHtml('Go :rocket:')).toBe('<p>Go <span class="emoji" title=":rocket:">🚀</span></p>');
  });

  it('重写时原样输出短代码', () => {
    expect(rewrite('Go :rocket: and :+1: at 12:30:45 :nope:')).toBe('Go :rocket: and :+1: at 12:30:45 :nope:');
  });
});

describe('上标', () => {
  it('^x^ 是上标，内容带空格的不是', () => {
    expect(types('E = mc^2^')).toEqual(['text', 'superscript']);
    expect(types('a ^b c^ d')).toEqual(['text']);
    expect(types('2^10 alone')).toEqual(['text']);
  });

  it('脚注写法 [^1] 不当上标', () => {
    expect(types('a [^x][^y] b')).toEqual(['text']);
  });

  it('转义的 ^ 不当上标', () => {
    expect(types('a \\^b^ c')).toEqual(['text']);
  });

  it('渲染成 <sup>', () => {
    expect(renderHtml('x^2^ + y^**2**^')).toContain('x<sup>2</sup>');
  });

  it('重写时原样输出', () => {
    expect(rewrite('x^2^ and H~2~O')).toBe('x^2^ and H~2~O');
  });

  it('上标里的文字带原文提示（所见即所得据此原样输出）', () => {
    const sup = inline('x^a*b^')[1] as Nodes & { children: Nodes[] };
    expect(sup.children[0]!.data?.zy?.raw).toBe('a*b');
  });
});

describe('下标', () => {
  it('默认关闭：~x~ 是 GFM 删除线，重写时保持单波浪线', () => {
    expect(types('H~2~O')).toEqual(['text', 'delete', 'text']);
    expect(renderHtml('H~2~O')).toBe('<p>H<del>2</del>O</p>');
    expect(rewrite('H~2~O and ~~gone~~')).toBe('H~2~O and ~~gone~~');
  });

  it('打开后 ~x~ 是下标，~~x~~ 仍是删除线', () => {
    setParseOptions({ subscript: true });
    expect(types('H~2~O')).toEqual(['text', 'subscript', 'text']);
    expect(types('~~gone~~')).toEqual(['delete']);
    expect(types('~a b~')).toEqual(['text']);
    expect(renderHtml('H~2~O ~~gone~~')).toBe('<p>H<sub>2</sub>O <del>gone</del></p>');
    expect(rewrite('H~2~O and ~~gone~~')).toBe('H~2~O and ~~gone~~');
  });

  it('打开后单波浪线删除线写成双波浪线（否则会变成下标）', () => {
    const doc = splitBlocks('~gone~');
    setParseOptions({ subscript: true });
    expect(stringifyBlock(doc.blocks[0]!.node, doc.style)).toBe('~~gone~~');
  });

  it('关掉后恢复默认行为', () => {
    setParseOptions({ subscript: true });
    setParseOptions({ subscript: false });
    expect(types('H~2~O')).toEqual(['text', 'delete', 'text']);
  });
});
