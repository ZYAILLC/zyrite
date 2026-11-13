import { syntaxTree } from '@codemirror/language';
import { type Diagnostic, linter, lintGutter } from '@codemirror/lint';
import type { EditorState, Extension, Text } from '@codemirror/state';
import { TomlError, parse as parseToml } from 'smol-toml';
import { parseAllDocuments } from 'yaml';

/**
 * JSON、JSON Lines、YAML、TOML 的格式校验：出错的地方画波浪线，行号旁边标记，悬停看原因。
 * 只报语法错误，不做 schema 校验。
 */

export type LintFormat = 'json' | 'jsonl' | 'yaml' | 'toml';

/** 错误信息只取第一行（yaml 和 smol-toml 会附带一段代码片段） */
const firstLine = (s: string) => s.split('\n')[0]!.trim();

function clampRange(doc: Text, from: number, to = from + 1): { from: number; to: number } {
  const f = Math.max(0, Math.min(from, doc.length));
  return { from: f, to: Math.max(f, Math.min(to, doc.length)) };
}

/** JSON.parse 的报错在 WebKit 里不带位置：用语法树里第一个错误节点定位，找不到再看报错里的 position */
function jsonErrorPos(state: EditorState, message: string): number {
  let pos = -1;
  syntaxTree(state).iterate({
    enter(n) {
      if (pos >= 0) return false;
      if (n.type.isError) pos = n.from;
      return undefined;
    },
  });
  if (pos >= 0) return pos;
  const m = /position (\d+)/i.exec(message);
  return m ? Number(m[1]) : state.doc.length;
}

export function lintText(state: EditorState, format: LintFormat): Diagnostic[] {
  const doc = state.doc;
  const text = doc.toString();
  if (!text.trim()) return [];
  const out: Diagnostic[] = [];
  if (format === 'json') {
    try {
      JSON.parse(text);
    } catch (e) {
      const message = firstLine(String((e as Error).message ?? e));
      out.push({ ...clampRange(doc, jsonErrorPos(state, message)), severity: 'error', message });
    }
  } else if (format === 'jsonl') {
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      if (!line.text.trim()) continue;
      try {
        JSON.parse(line.text);
      } catch (e) {
        out.push({ from: line.from, to: line.to, severity: 'error', message: firstLine(String((e as Error).message ?? e)) });
        if (out.length >= 100) break;
      }
    }
  } else if (format === 'yaml') {
    for (const d of parseAllDocuments(text)) {
      for (const err of d.errors) {
        out.push({ ...clampRange(doc, err.pos[0], err.pos[1]), severity: 'error', message: firstLine(err.message) });
      }
    }
  } else {
    try {
      parseToml(text);
    } catch (e) {
      if (e instanceof TomlError) {
        const line = doc.line(Math.min(Math.max(1, e.line), doc.lines));
        const from = line.from + Math.max(0, e.column - 1);
        out.push({ ...clampRange(doc, from), severity: 'error', message: firstLine(e.message) });
      } else {
        out.push({ ...clampRange(doc, 0), severity: 'error', message: firstLine(String(e)) });
      }
    }
  }
  return out;
}

/** 编辑器扩展：停止输入 400 毫秒后校验一次 */
export function formatLinter(format: LintFormat): Extension {
  return [linter((view) => lintText(view.state, format), { delay: 400 }), lintGutter()];
}
