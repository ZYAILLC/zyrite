import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Tag } from '@lezer/highlight';

/**
 * 文本文件按文件名选语言：先用 @codemirror/language-data 的扩展名、文件名规则（Dockerfile、nginx.conf 等），
 * 认不出的再按下面的别名换成相近的格式；日志用自带的简单高亮。语言包按需加载，没用到的不加载。
 */

/** 扩展名别名：换成 language-data 认识的扩展名 */
const ALIAS: Record<string, string> = {
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  ndjson: 'json',
  geojson: 'json',
  conf: 'properties',
  cfg: 'properties',
  env: 'properties',
  service: 'properties',
  desktop: 'properties',
  reg: 'properties',
  rules: 'properties',
  plist: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  mts: 'ts',
  cts: 'ts',
  pyi: 'py',
  hh: 'hpp',
  kts: 'kt',
};

/** 按文件名认、内容是 TOML 的锁文件 */
const TOML_NAMES = /^(cargo|poetry|uv|pdm)\.lock$/i;

export const LOG_EXT = /\.(log|out)$/i;

export interface CodeLanguage {
  /** 状态栏上显示的名字，例如 "YAML"、"Log"、"Plain Text" */
  name: string;
  /** 加载语言包；纯文本返回 null */
  load: () => Promise<LanguageSupport | null>;
}

const ext = (fileName: string) => /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? '';

function describe(fileName: string): LanguageDescription | null {
  const direct = LanguageDescription.matchFilename(languages, fileName);
  if (direct) return direct;
  if (TOML_NAMES.test(fileName)) return LanguageDescription.matchFilename(languages, 'x.toml');
  const alias = ALIAS[ext(fileName)];
  return alias ? LanguageDescription.matchFilename(languages, `x.${alias}`) : null;
}

/** 文件用什么语言高亮 */
export function codeLanguage(fileName: string): CodeLanguage {
  if (LOG_EXT.test(fileName)) return { name: 'Log', load: async () => logSupport };
  const desc = describe(fileName);
  if (!desc) return { name: 'Plain Text', load: async () => null };
  return { name: desc.name, load: () => desc.load() };
}

/** 格式校验用：json、jsonl、yaml、toml，其他返回 null（JSONC、JSON5 允许注释和尾逗号，不校验） */
export function lintFormat(fileName: string): 'json' | 'jsonl' | 'yaml' | 'toml' | null {
  const e = ext(fileName);
  if (e === 'json' || e === 'geojson') return 'json';
  if (e === 'jsonl' || e === 'ndjson') return 'jsonl';
  if (e === 'yaml' || e === 'yml') return 'yaml';
  if (e === 'toml' || TOML_NAMES.test(fileName)) return 'toml';
  return null;
}

// ---------- 日志 ----------

/** 日志里的级别和时间，颜色在 code.ts 里定义 */
export const logTags = {
  error: Tag.define(),
  warn: Tag.define(),
  info: Tag.define(),
  debug: Tag.define(),
  time: Tag.define(),
};

const TIME =
  /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)/;
const LEVEL: [RegExp, keyof typeof logTags][] = [
  [/^(?:ERROR|ERR|FATAL|CRITICAL|CRIT|PANIC|SEVERE|EMERG|ALERT|FAIL(?:ED|URE)?)\b/, 'error'],
  [/^(?:Traceback|Exception|Error)\b/, 'error'],
  [/^(?:WARNING|WARN)\b/, 'warn'],
  [/^(?:INFO|NOTICE)\b/, 'info'],
  [/^(?:DEBUG|TRACE|VERBOSE)\b/, 'debug'],
  [/^level=(?:error|fatal|panic)\b/i, 'error'],
  [/^level=warn(?:ing)?\b/i, 'warn'],
  [/^level=info\b/i, 'info'],
  [/^level=(?:debug|trace)\b/i, 'debug'],
];

const logLanguage = StreamLanguage.define<null>({
  name: 'log',
  token(stream) {
    if (stream.sol() || /[\s[(]/.test(stream.string.charAt(stream.pos - 1))) {
      if (stream.match(TIME)) return 'time';
      for (const [re, tag] of LEVEL) if (stream.match(re)) return tag;
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';
    if (!stream.match(/^[\w.-]+/)) stream.next();
    return null;
  },
  tokenTable: logTags,
});

const logSupport = new LanguageSupport(logLanguage);
