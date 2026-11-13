// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodeEditor } from './code';
import { codeLanguage, lintFormat } from './languages';
import { lintText } from './lint';

const lint = (text: string, format: Parameters<typeof lintText>[1]) => lintText(EditorState.create({ doc: text }), format);

describe('按文件名选语言', () => {
  it.each([
    ['config.yaml', 'YAML'],
    ['package.json', 'JSON'],
    ['tsconfig.jsonc', 'JSON'],
    ['events.ndjson', 'JSON'],
    ['Cargo.toml', 'TOML'],
    ['Cargo.lock', 'TOML'],
    ['nginx.conf', 'Nginx'],
    ['app.conf', 'Properties files'],
    ['Dockerfile', 'Dockerfile'],
    ['deploy.sh', 'Shell'],
    ['server.log', 'Log'],
    ['notes.srt', 'Plain Text'],
  ])('%s → %s', (name, lang) => {
    expect(codeLanguage(name).name).toBe(lang);
  });

  it('格式校验只对 JSON、JSON Lines、YAML、TOML', () => {
    expect(lintFormat('a.json')).toBe('json');
    expect(lintFormat('a.jsonc')).toBeNull();
    expect(lintFormat('a.jsonl')).toBe('jsonl');
    expect(lintFormat('a.YML')).toBe('yaml');
    expect(lintFormat('poetry.lock')).toBe('toml');
    expect(lintFormat('a.xml')).toBeNull();
  });
});

describe('格式校验', () => {
  it('合法的内容没有错误', () => {
    expect(lint('{"a": [1, 2]}', 'json')).toEqual([]);
    expect(lint('{"a":1}\n\n{"b":2}\n', 'jsonl')).toEqual([]);
    expect(lint('a: 1\nb:\n  - x\n---\nc: 2\n', 'yaml')).toEqual([]);
    expect(lint('[server]\nport = 8080\n', 'toml')).toEqual([]);
    expect(lint('   \n', 'json')).toEqual([]);
  });

  it('JSON：报错并给出位置', () => {
    const [d] = lint('{"a": 1,}', 'json');
    expect(d?.severity).toBe('error');
    expect(d!.from).toBeGreaterThanOrEqual(0);
    expect(d!.to).toBeLessThanOrEqual(9);
  });

  it('JSON Lines：逐行报错', () => {
    const out = lint('{"a":1}\nnot json\n{"b":2}', 'jsonl');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: 8, to: 16 });
  });

  it('YAML：报错的位置在出错的那一行', () => {
    const text = 'a: 1\nb: [1, 2\nc: 3\n';
    const out = lint(text, 'yaml');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.message).not.toContain('\n');
  });

  it('TOML：按行列定位', () => {
    const text = '[server]\nport = \n';
    const [d] = lint(text, 'toml');
    expect(d?.severity).toBe('error');
    expect(d!.from).toBeGreaterThanOrEqual(9);
  });
});

describe('文本文件编辑器', () => {
  let destroy: (() => void) | null = null;
  afterEach(() => destroy?.());

  it('原样保留 CRLF，按行定位光标', () => {
    const parent = document.createElement('div');
    const source = 'a: 1\r\nb: 2\r\nc: 3\r\n';
    const ed = createCodeEditor({ parent, source, fileName: 'x.yaml' });
    destroy = ed.destroy;
    expect(ed.getText()).toBe(source);
    ed.setCursorBlock(2);
    expect(ed.getCursorBlock()).toBe(2);
    expect(ed.getSelectionInfo()).toBeNull();
    expect(parent.querySelector('.cm-lineNumbers')).not.toBeNull();
  });

  it('只读时不能插入', () => {
    const parent = document.createElement('div');
    const ed = createCodeEditor({ parent, source: 'line\n', fileName: 'x.log', readOnly: true });
    destroy = ed.destroy;
    ed.insertMarkdown('more');
    ed.replaceSelection('x');
    expect(ed.getText()).toBe('line\n');
  });
});
