import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/**
 * 代码块语法高亮，两种编辑器共用。颜色取主题的 `--z-syn-*` 变量（packages/themes），
 * 切换主题不用重建编辑器，深色主题也看得清。
 *
 * 只给代码里的 token 上色：实时预览的 Markdown 本身（标题、链接、转义、行内公式等）
 * 也会经过这个高亮器，所以不映射 Markdown 用到的标签（heading、link、url、escape、special(string) 等）。
 */
const v = (name: string) => `var(--z-syn-${name})`;

export const codeHighlightStyle = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self],
    color: v('keyword'),
  },
  { tag: [t.string, t.regexp, t.character, t.docString], color: v('string') },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit, t.color], color: v('number') },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta, t.annotation], color: v('comment') },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.variableName),
      t.definition(t.function(t.variableName)),
      t.definition(t.propertyName),
      t.macroName,
      t.attributeName,
    ],
    color: v('def'),
  },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.standard(t.typeName)], color: v('type') },
  { tag: t.inserted, color: 'var(--z-review-add-text)' },
  { tag: t.deleted, color: 'var(--z-review-del-text)' },
  { tag: t.invalid, color: 'var(--z-review-del-text)' },
]);
