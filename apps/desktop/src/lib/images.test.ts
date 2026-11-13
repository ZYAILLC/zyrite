import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../store';
import { webBackend } from './backend';
import { deps, dropFiles } from './document';
import { activeEditor } from './editorRef';
import { fakeBackend, resetStore } from './fakeBackend.testutil';
import { expandTemplate, pasteImages, saveImageFile } from './images';

let fake: ReturnType<typeof fakeBackend>;
const inserted: string[] = [];

beforeEach(() => {
  resetStore();
  fake = fakeBackend();
  deps.backend = fake.b;
  inserted.length = 0;
  activeEditor.current = { insertMarkdown: (md: string) => inserted.push(md) } as never;
});

describe('路径模板', () => {
  it('文档名、时间、扩展名', () => {
    const now = new Date(2026, 10, 8, 9, 5, 3);
    expect(expandTemplate('./assets/{filename}-{yyyyMMdd-HHmmss}.png', '/v/笔记.md', now, 'jpg')).toBe('./assets/笔记-20261108-090503.jpg');
    expect(expandTemplate('img/{yyyy}/{MM}/{name}', '/v/a.md', now, 'png', 'shot.webp')).toBe('img/2026/11/shot.png');
  });
});

describe('粘贴、拖入图片', () => {
  it('粘贴：按模板存到文档旁边，插入相对路径', async () => {
    useApp.setState({ filePath: '/v/notes/a.md', folder: '/v' });
    const md = await saveImageFile(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    expect(md).toMatch(/^!\[a-\d{8}-\d{6}\]\(assets\/a-\d{8}-\d{6}\.png\)$/);
    const [path, data] = [...fake.state.binaries][0]!;
    expect(path).toMatch(/^\/v\/notes\/assets\/a-\d{8}-\d{6}\.png$/);
    expect(data).toBe('AQID');
  });

  it('没保存、也没打开文件夹时提示', async () => {
    expect(await saveImageFile(new Blob([], { type: 'image/png' }))).toBeNull();
    expect(useApp.getState().notice?.error).toBe(true);
  });

  it('设置了图床：上传后插入图床地址', async () => {
    useApp.setState({ filePath: '/v/a.md', image: { ...useApp.getState().image, upload: 'picgo' } });
    expect(pasteImages([new File([new Uint8Array([1])], 'image.png', { type: 'image/png' })])).toBe(true);
    await vi.waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0]).toMatch(/^!\[a-\d{8}-\d{6}\]\(https:\/\/img\.example\/x\.png\)$/);
    expect(fake.state.uploads[0]).toMatch(/^\/v\/assets\//);
    expect(pasteImages([new File(['x'], 'a.txt', { type: 'text/plain' })])).toBe(false);
  });

  it('拖入：库外的图片复制到 assets，库里的直接引用，其他文件是普通链接', async () => {
    useApp.setState({ filePath: '/v/a.md', folder: '/v' });
    fake.state.binaries.set('/tmp/外面.png', 'AA==');
    await dropFiles(['/tmp/外面.png', '/v/img/in.png', '/tmp/doc.pdf']);
    const [md] = inserted;
    const lines = md!.split('\n');
    expect(lines[0]).toMatch(/^!\[外面\]\(assets\/a-\d{8}-\d{6}\.png\)$/);
    expect(lines[1]).toBe('![in](img/in.png)');
    expect(lines[2]).toBe('[doc.pdf](../tmp/doc.pdf)');
  });
});

describe('网络图片按设置加载', () => {
  it('打开时原样返回，关掉时返回空地址', () => {
    const url = 'https://example.com/a.png';
    expect(webBackend.resolveImage(url, '/v/a.md')).toBe(url);
    useApp.setState({ image: { ...useApp.getState().image, remote: false } });
    expect(webBackend.resolveImage(url, '/v/a.md')).toBe('');
    expect(webBackend.resolveImage('data:image/png;base64,AAAA', '/v/a.md')).toBe('data:image/png;base64,AAAA');
  });
});
