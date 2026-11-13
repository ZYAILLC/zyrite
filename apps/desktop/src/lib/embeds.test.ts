import { beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../store';
import { deps, openPath } from './document';
import { resolveEmbed } from './embeds';
import { fakeBackend, resetStore } from './fakeBackend.testutil';
import { openIndex } from './linkIndex';
import { refreshTree } from './vault';

let fake: ReturnType<typeof fakeBackend>;

beforeEach(async () => {
  resetStore();
  fake = fakeBackend();
  deps.backend = fake.b;
  fake.write('/v/docs/plan.md', '---\ntitle: P\n---\n# Plan\n\nintro\n\n## Steps\n\none\n\n## Later\n\ntwo\n');
  fake.write('/v/notes/a.md', 'A');
  fake.write('/v/notes/pic.png', '');
  fake.write('/v/assets/deep/logo.png', '');
  fake.write('/v/assets/logo.png', '');
  useApp.getState().setFolder('/v');
  await refreshTree();
  await openIndex();
  await openPath('/v/notes/a.md');
});

describe('图片嵌入', () => {
  it('先按当前文档所在文件夹找', () => {
    expect(resolveEmbed('pic.png')).toMatchObject({ kind: 'image', src: 'asset:///v/notes/pic.png', alt: 'pic.png' });
  });

  it('再按库根目录找；带宽度或宽x高', () => {
    expect(resolveEmbed('assets/deep/logo.png|200')).toMatchObject({ src: 'asset:///v/assets/deep/logo.png', width: 200 });
    expect(resolveEmbed('assets/logo.png|120x80')).toMatchObject({ width: 120, height: 80 });
  });

  it('只写文件名时在整个库里找，同名取路径最短的', () => {
    expect(resolveEmbed('logo.png')).toMatchObject({ src: 'asset:///v/assets/logo.png' });
  });

  it('| 后面不是尺寸时当作说明文字', () => {
    expect(resolveEmbed('pic.png|A picture')).toMatchObject({ alt: 'A picture', width: undefined });
  });

  it('找不到的图片返回 null', () => {
    expect(resolveEmbed('nope.png')).toBeNull();
  });
});

describe('笔记嵌入', () => {
  it('按双链规则找到笔记，读出内容（去掉 frontmatter）', async () => {
    const info = resolveEmbed('plan');
    expect(info).toMatchObject({ kind: 'note', title: 'plan' });
    if (info?.kind !== 'note') throw new Error('not a note');
    expect(await info.load()).toBe('# Plan\n\nintro\n\n## Steps\n\none\n\n## Later\n\ntwo\n');
  });

  it('带 #标题 时只取那一节', async () => {
    const info = resolveEmbed('plan#Steps');
    expect(info).toMatchObject({ kind: 'note', title: 'plan › Steps' });
    if (info?.kind !== 'note') throw new Error('not a note');
    expect(await info.load()).toBe('## Steps\n\none\n');
  });

  it('不存在的笔记返回 null', () => {
    expect(resolveEmbed('missing note')).toBeNull();
  });
});
