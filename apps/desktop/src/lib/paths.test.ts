import { describe, expect, it } from 'vitest';
import { mediaKind } from '@zyrite/editor-common';
import {
  basename,
  dirname,
  isDocument,
  isMarkdownDoc,
  isSensitive,
  isTextFile,
  isUrl,
  linkForFile,
  linkPath,
  MEDIA_EXT,
  relativePath,
  resolvePath,
} from './paths';

describe('paths', () => {
  it('basename / dirname', () => {
    expect(basename('/a/b/c.md')).toBe('c.md');
    expect(basename('C:\\docs\\plan.md')).toBe('plan.md');
    expect(basename('c.md')).toBe('c.md');
    expect(dirname('/a/b/c.md')).toBe('/a/b');
    expect(dirname('/c.md')).toBe('/');
    expect(dirname('C:\\docs\\plan.md')).toBe('C:\\docs');
    expect(dirname('C:\\plan.md')).toBe('C:\\');
    expect(dirname('c.md')).toBe('');
  });

  it('isUrl', () => {
    expect(isUrl('https://z-y.ai')).toBe(true);
    expect(isUrl('mailto:a@b.c')).toBe(true);
    expect(isUrl('C:\\a.png')).toBe(false);
    expect(isUrl('./a.png')).toBe(false);
    expect(isUrl('img/a.png')).toBe(false);
  });

  it('resolvePath', () => {
    expect(resolvePath('/a/b', 'img/x.png')).toBe('/a/b/img/x.png');
    expect(resolvePath('/a/b', './x.png')).toBe('/a/b/x.png');
    expect(resolvePath('/a/b', '../x.png')).toBe('/a/x.png');
    expect(resolvePath('/a/b', '/abs/x.png')).toBe('/abs/x.png');
    expect(resolvePath('/', 'x.md')).toBe('/x.md');
    expect(resolvePath('C:\\docs', '..\\x.md')).toBe('C:\\x.md');
    expect(resolvePath('C:\\docs', 'sub/x.md')).toBe('C:\\docs\\sub\\x.md');
  });

  it('linkPath', () => {
    expect(linkPath('other%20note.md#标题')).toBe('other note.md');
    expect(linkPath('a.md?x=1')).toBe('a.md');
  });
});

describe('拖入文件生成链接', () => {
  it('relativePath', () => {
    expect(relativePath('/a/b', '/a/b/img/x.png')).toBe('img/x.png');
    expect(relativePath('/a/b', '/a/c/x.png')).toBe('../c/x.png');
    expect(relativePath('/a/b', '/x.png')).toBe('../../x.png');
    expect(relativePath('C:\\docs', 'C:\\docs\\img\\x.png')).toBe('img/x.png');
    expect(relativePath('C:\\docs', 'D:\\x.png')).toBe('D:/x.png');
  });

  it('linkForFile', () => {
    expect(linkForFile('/a/b/assets/my logo.png', '/a/b/note.md')).toBe('![my logo](assets/my%20logo.png)');
    expect(linkForFile('/a/c/方案.md', '/a/b/note.md')).toBe('[方案](../c/方案.md)');
    expect(linkForFile('/a/b/report (final).pdf', '/a/b/note.md')).toBe('[report (final).pdf](report%20%28final%29.pdf)');
    expect(linkForFile('/x/[draft].md', null)).toBe('[\\[draft\\]](/x/[draft].md)');
  });

  it('视频、音频扩展名和 editor-common 的 mediaKind 一致', () => {
    for (const ext of ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']) {
      expect(MEDIA_EXT.test(`a.${ext.toUpperCase()}`)).toBe(true);
      expect(mediaKind(`a.${ext}`)).not.toBeNull();
    }
    expect(MEDIA_EXT.test('a.png')).toBe(false);
    expect(MEDIA_EXT.test('a.mp4.md')).toBe(false);
  });
});

describe('文件类型', () => {
  it('文本文件：按扩展名或文件名认，Markdown 和 .txt 不算', () => {
    for (const p of ['/a/config.yaml', '/a/b.JSON', 'Cargo.toml', '/a/app.log', '/a/Dockerfile', 'Makefile', '/a/x.tsx']) {
      expect(isTextFile(p)).toBe(true);
    }
    for (const p of ['/a/note.md', '/a/a.txt', '/a/logo.png', '/a/tool.exe', '/a/clip.mp4']) expect(isTextFile(p)).toBe(false);
    expect(isDocument('/a/note.md') && isDocument('/a/a.yml') && !isDocument('/a/logo.png')).toBe(true);
  });

  it('Markdown 文档：新建的、.md、.txt；其他扩展名都按纯文本编辑', () => {
    expect(isMarkdownDoc(null)).toBe(true);
    expect(isMarkdownDoc('/a/note.MD')).toBe(true);
    expect(isMarkdownDoc('/a/a.txt')).toBe(true);
    expect(isMarkdownDoc('/a/config.yaml')).toBe(false);
    expect(isMarkdownDoc('/a/unknown.xyz')).toBe(false);
  });

  it('可能含密钥的文件', () => {
    for (const p of ['/a/.env', '/a/.env.local', '/a/server.pem', '/a/id_rsa', '/a/credentials.json']) expect(isSensitive(p)).toBe(true);
    for (const p of ['/a/.env.example', '/a/config.yaml', '/a/keys.md']) expect(isSensitive(p)).toBe(false);
  });
});
