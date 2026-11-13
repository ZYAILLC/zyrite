/**
 * 左栏文档页"属性"用：读出 YAML frontmatter 的顶层键值。
 * 只认常见写法：`键: 值`、`键: [a, b]`、以及下面几行 `- a`；更复杂的结构按原文显示。
 */
export interface Property {
  key: string;
  value: string | string[];
}

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2');

export function parseFrontmatter(text: string): Property[] | null {
  const src = text.replace(/^﻿/, '');
  if (!/^---\r?\n/.test(src)) return null;
  const lines = src.split(/\r?\n/);
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  if (end < 0) return null;
  const body = lines.slice(1, end);
  const out: Property[] = [];
  for (let i = 0; i < body.length; i++) {
    const m = /^([^\s#:][^:]*):(.*)$/.exec(body[i] ?? '');
    if (!m) continue;
    const key = m[1]!.trim();
    const raw = m[2]!.trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      out.push({ key, value: raw.slice(1, -1).split(',').map(unquote).filter(Boolean) });
    } else if (!raw) {
      const items: string[] = [];
      while (i + 1 < body.length && /^\s*-(\s|$)/.test(body[i + 1] ?? '')) {
        items.push(unquote((body[++i] ?? '').replace(/^\s*-\s?/, '')));
      }
      // 不是列表的嵌套结构：原样拼起来
      if (!items.length) {
        const nested: string[] = [];
        while (i + 1 < body.length && /^\s+\S/.test(body[i + 1] ?? '')) nested.push((body[++i] ?? '').trim());
        out.push({ key, value: nested.join(' ') });
      } else out.push({ key, value: items });
    } else out.push({ key, value: unquote(raw) });
  }
  return out;
}

/**
 * 反向链接的上下文按纯文字显示（例如 `[[笔记|别名]]` 只显示"别名"）：
 * 双链和链接只留显示的文字，去掉强调、行内代码、标题、引用、列表和任务框的标记。
 */
export function plainContext(line: string): string {
  return line
    .replace(/!?\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?/, '')
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .trim();
}
