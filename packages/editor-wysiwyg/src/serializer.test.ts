import { Fragment } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { schema } from './schema';
import { BlockSerializer } from './serializer';

/** 顶层第 i 块的起始位置 */
const blockPos = (doc: import('prosemirror-model').Node, i: number) => {
  let p = 0;
  for (let k = 0; k < i; k++) p += doc.child(k).nodeSize;
  return p;
};

describe('BlockSerializer 编辑场景', () => {
  it('在段落中间回车拆成两段：只有这一段变化', () => {
    const src = '# 标题\n\n第一段文字\n\n\n第二段\n';
    const s = new BlockSerializer(src);
    const at = blockPos(s.doc, 1) + 1 + 3;
    const doc = new Transform(s.doc).split(at).doc;
    expect(s.serialize(doc).text).toBe('# 标题\n\n第一段\n\n文字\n\n\n第二段\n');
  });

  it('删除一块：前后的分隔保留其中一个', () => {
    const src = 'a\n\nb\n\nc\n';
    const s = new BlockSerializer(src);
    const from = blockPos(s.doc, 1);
    const doc = new Transform(s.doc).delete(from, from + s.doc.child(1).nodeSize).doc;
    expect(s.serialize(doc).text).toBe('a\n\nc\n');
  });

  it('插入新段落：用空行分隔，其他不变', () => {
    const src = '* x\n* y\n\n__粗__\n';
    const s = new BlockSerializer(src);
    const p = schema.nodes.paragraph!.create(null, schema.text('新的'));
    const doc = new Transform(s.doc).insert(blockPos(s.doc, 1), p).doc;
    expect(s.serialize(doc).text).toBe('* x\n* y\n\n新的\n\n__粗__\n');
  });

  it('改列表的某一项：其他项原样（包括 4 空格缩进和编号写法）', () => {
    const src = '1) 一\n2) 二\n    - 子项\n3) 三\n';
    const s = new BlockSerializer(src);
    // 第三项的段落文字末尾加一个字
    const list = s.doc.child(0);
    let pos = 1;
    for (let k = 0; k < 2; k++) pos += list.child(k).nodeSize;
    const doc = new Transform(s.doc).insert(pos + 1 + 1 + 1, schema.text('!')).doc;
    expect(s.serialize(doc).text).toBe('1) 一\n2) 二\n    - 子项\n3) 三!\n');
  });

  it('有序列表删除第一项：后面的项重新编号', () => {
    const src = '1. a\n2. b\n3. c\n';
    const s = new BlockSerializer(src);
    const list = s.doc.child(0);
    const doc = new Transform(s.doc).delete(1, 1 + list.child(0).nodeSize).doc;
    expect(s.serialize(doc).text).toBe('1. b\n2. c\n');
  });

  it('表格加一行：分隔行和其他行原样', () => {
    const src = '| a | b |\n|---|:-:|\n| 1 | 2 |\n';
    const s = new BlockSerializer(src);
    const table = s.doc.child(0);
    const row = schema.nodes.table_row!.create(null, [
      schema.nodes.table_cell!.create(null, schema.text('3')),
      schema.nodes.table_cell!.create({ align: 'center' }, schema.text('4')),
    ]);
    const doc = new Transform(s.doc).insert(table.nodeSize - 1, row).doc;
    expect(s.serialize(doc).text).toBe('| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |\n');
  });

  it('CRLF 文档里新写的内容也用 CRLF', () => {
    const src = 'a\r\n\r\nb\r\n';
    const s = new BlockSerializer(src);
    const p = schema.nodes.paragraph!.create(null, [
      schema.text('x'),
      schema.nodes.hard_break!.create(),
      schema.text('y'),
    ]);
    const doc = new Transform(s.doc).insert(s.doc.content.size, p).doc;
    expect(s.serialize(doc).text).toBe('a\r\n\r\nb\r\n\r\nx\\\r\ny\r\n');
  });

  it('空文档：不编辑仍为空，写字后加末尾换行', () => {
    const s = new BlockSerializer('');
    expect(s.serialize(s.doc).text).toBe('');
    const doc = new Transform(s.doc).insert(1, schema.text('你好')).doc;
    expect(s.serialize(doc).text).toBe('你好\n');
  });

  it('新写的强调沿用文档已有的符号', () => {
    const s = new BlockSerializer('_斜_ 和 __粗__\n');
    const p = schema.nodes.paragraph!.create(null, [
      schema.text('新', [schema.marks.em!.create()]),
      schema.text('的', [schema.marks.strong!.create()]),
    ]);
    const doc = new Transform(s.doc).insert(s.doc.content.size, p).doc;
    expect(s.serialize(doc).text).toBe('_斜_ 和 __粗__\n\n_新_**的**\n');
  });

  it('文本改动后转义正确（原文段失效时不原样输出）', () => {
    const s = new BlockSerializer('a \\* b\n');
    const doc = new Transform(s.doc).insert(1, schema.text('c')).doc;
    expect(s.serialize(doc).text).toBe('ca \\* b\n');
  });

  it('粘贴的块带着别处的 bid：不会被当成原文', () => {
    const s = new BlockSerializer('a\n\nb\n');
    const copy = s.doc.child(1).copy(s.doc.child(1).content);
    const doc = new Transform(s.doc).insert(0, Fragment.from(copy)).doc;
    expect(s.serialize(doc).text).toBe('b\n\na\n\nb\n');
  });
});
