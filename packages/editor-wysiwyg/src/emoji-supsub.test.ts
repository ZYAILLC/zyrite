import { setParseOptions } from '@zyrite/md-blocks';
import { loadCorpus } from '@zyrite/md-blocks/corpus';
import type { Node as PMNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from './schema';
import { BlockSerializer } from './serializer';

afterEach(() => setParseOptions({ subscript: false }));

/** 第一块里的行内内容：[类型或文字, marks] */
const inline = (doc: PMNode) => {
  const out: [string, string[]][] = [];
  doc.child(0).forEach((c) => {
    const marks = c.marks.map((m) => m.type.name).filter((m) => m !== 'src');
    out.push([c.isText ? c.text! : `${c.type.name}:${c.attrs.value as string}`, marks]);
  });
  return out;
};

/** 在第一块末尾加一个字后保存 */
const editFirst = (src: string) => {
  const s = new BlockSerializer(src);
  const end = s.doc.child(0).nodeSize - 1;
  return s.serialize(new Transform(s.doc).insert(end, schema.text('!')).doc).text;
};

describe('所见即所得：表情、上下标', () => {
  it('表情是行内节点，上标是 mark', () => {
    const s = new BlockSerializer('Go :rocket: x^2^ H~2~O\n');
    expect(inline(s.doc)).toEqual([
      ['Go ', []],
      ['emoji:rocket', []],
      [' x', []],
      ['2', ['superscript']],
      [' H', []],
      ['2', ['strike']],
      ['O', []],
    ]);
  });

  it('打开下标后 ~x~ 是下标 mark', () => {
    setParseOptions({ subscript: true });
    const s = new BlockSerializer('H~2~O ~~gone~~\n');
    expect(inline(s.doc)).toEqual([
      ['H', []],
      ['2', ['subscript']],
      ['O ', []],
      ['gone', ['strike']],
    ]);
  });

  it('块被编辑后重写：短代码、上标、单波浪线删除线原样', () => {
    expect(editFirst('Go :rocket: :+1: x^a*b^ H~2~O 12:30:45 :nope:\n')).toBe(
      'Go :rocket: :+1: x^a*b^ H~2~O 12:30:45 :nope:!\n',
    );
  });

  it('打开下标后块被编辑：下标和双波浪线删除线原样', () => {
    setParseOptions({ subscript: true });
    expect(editFirst('H~2~O and ~~gone~~ x^2^\n')).toBe('H~2~O and ~~gone~~ x^2^!\n');
  });

  it('新写的上标、下标、表情', () => {
    setParseOptions({ subscript: true });
    const s = new BlockSerializer('a\n');
    const p = schema.nodes.paragraph!.create(null, [
      schema.text('x'),
      schema.text('2', [schema.marks.superscript!.create()]),
      schema.text(' H'),
      schema.text('2', [schema.marks.subscript!.create()]),
      schema.text('O '),
      schema.nodes.emoji!.create({ value: 'tada' }),
    ]);
    const doc = new Transform(s.doc).insert(s.doc.content.size, p).doc;
    expect(s.serialize(doc).text).toBe('a\n\nx^2^ H~2~O :tada:\n');
  });

  // 和 fidelity.test.ts 一样的验收，换成打开下标的解析方式
  describe.each(loadCorpus().map((c) => [c.name, c.source] as const))('打开下标：%s', (_name, source) => {
    it('不编辑直接保存逐字节一致；改一块只有这一块变化', () => {
      setParseOptions({ subscript: true });
      const s = new BlockSerializer(source);
      expect(s.serialize(s.doc).text).toBe(source);
      s.base.blocks.forEach((b, i) => {
        let start = 0;
        for (let k = 0; k < i; k++) start += s.doc.child(k).nodeSize;
        let pos: number | undefined;
        s.doc.child(i).descendants((node, p) => {
          if (pos === undefined && node.isText && node.text) pos = start + 1 + p + 1;
          return pos === undefined;
        });
        if (pos === undefined) return;
        const out = s.serialize(new Transform(s.doc).insert(pos, schema.text('字')).doc).text;
        expect(out.slice(0, b.from)).toBe(source.slice(0, b.from));
        expect(out.slice(out.length - (source.length - b.to))).toBe(source.slice(b.to));
      });
    });
  });
});
