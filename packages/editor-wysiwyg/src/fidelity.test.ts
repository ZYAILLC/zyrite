import { loadCorpus } from '@zyrite/md-blocks/corpus';
import type { Node as PMNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { BlockSerializer } from './serializer';

/**
 * 验收标准：打开任意 md，在所见即所得下改一个字再保存，git diff 只出现那一块的变化。
 * 语料在 tests/corpus/。
 */
const corpus = loadCorpus();

/** 顶层第 index 块里第一个可以插字的位置（文本节点内） */
function firstTextPos(doc: PMNode, index: number): number | undefined {
  let start = 0;
  for (let i = 0; i < index; i++) start += doc.child(i).nodeSize;
  const block = doc.child(index);
  let found: number | undefined;
  block.descendants((node, pos) => {
    if (found !== undefined) return false;
    if (node.isText && node.text) {
      found = start + 1 + pos + Math.min(1, node.text.length);
      return false;
    }
    return true;
  });
  return found;
}

describe.each(corpus.map((c) => [c.name, c.source] as const))('%s', (_name, source) => {
  it('不编辑直接保存：逐字节一致', () => {
    const s = new BlockSerializer(source);
    expect(s.serialize(s.doc).text).toBe(source);
  });

  it('在每一块里改一个字：只有这一块变化', () => {
    const s = new BlockSerializer(source);
    const { blocks } = s.base;
    let edited = 0;
    for (let i = 0; i < blocks.length; i++) {
      const pos = firstTextPos(s.doc, i);
      if (pos === undefined) continue;
      const doc = new Transform(s.doc).insert(pos, s.doc.type.schema.text('字')).doc;
      const out = s.serialize(doc).text;
      const b = blocks[i]!;
      expect(out.slice(0, b.from), `块 ${i} 之前`).toBe(source.slice(0, b.from));
      expect(out.slice(out.length - (source.length - b.to)), `块 ${i} 之后`).toBe(source.slice(b.to));
      expect(out).toContain('字');
      edited++;
    }
    if (blocks.length) expect(edited).toBeGreaterThan(0);
  });
});

/**
 * 块内保真率：块被编辑后整块重新序列化，除了改动的字以外和原文一致的比例。
 * 不影响验收（验收只要求不波及其他块），用来跟踪序列化质量；低于阈值说明回退了。
 */
describe('块内保真率', () => {
  it('块被编辑后重写、除改动外与原文一致的块 ≥ 95%', () => {
    let same = 0;
    let total = 0;
    const diffs: string[] = [];
    for (const { name, source } of corpus) {
      const s = new BlockSerializer(source);
      s.base.blocks.forEach((b, i) => {
        total++;
        const text = s.rewriteOriginal(i);
        if (text === b.text) same++;
        else diffs.push(`${name}#${i}\n--- 原文\n${b.text}\n--- 重写\n${text}`);
      });
    }
    const rate = same / total;
    if (process.env.FIDELITY_VERBOSE) console.log(diffs.join('\n\n'));
    console.log(`块内保真率 ${same}/${total} = ${(rate * 100).toFixed(1)}%`);
    expect(rate).toBeGreaterThanOrEqual(0.95);
  });
});
