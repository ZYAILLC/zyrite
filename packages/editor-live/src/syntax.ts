import { tags as t } from '@lezer/highlight';
import type { BlockContext, Element, InlineContext, Line, MarkdownConfig } from '@lezer/markdown';

/**
 * lezer-markdown 扩展：Obsidian 语法（==高亮==、[[双链]]、#标签）、数学公式（$…$、$$…$$）、YAML frontmatter、脚注 [^1]。
 * 规则和 md-blocks 的解析保持一致。
 */

const isSpace = (ch: number) => ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === -1;
const DOLLAR = 36;
const EQ = 61;
const HASH = 35;
const BRACKET = 91;
const BANG = 33;
const CARET = 94;

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

export const highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': t.special(t.content) } },
    { name: 'HighlightMark', style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== EQ || cx.char(pos + 1) !== EQ || cx.char(pos + 2) === EQ) return -1;
        const before = cx.char(pos - 1);
        const after = cx.char(pos + 2);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !isSpace(after), !isSpace(before));
      },
      after: 'Emphasis',
    },
  ],
};

export const wikiLink: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink', style: t.link },
    { name: 'WikiLinkMark', style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: 'WikiLink',
      parse(cx: InlineContext, next: number, pos: number) {
        let start = pos;
        if (next === BANG) {
          if (cx.char(pos + 1) !== BRACKET) return -1;
          pos++;
        } else if (next !== BRACKET) return -1;
        if (cx.char(pos + 1) !== BRACKET) return -1;
        const text = cx.slice(pos + 2, cx.end);
        const m = /^([^[\]\n]+)\]\]/.exec(text);
        if (!m) return -1;
        const end = pos + 2 + m[0].length;
        return cx.addElement(
          cx.elt('WikiLink', start, end, [cx.elt('WikiLinkMark', start, pos + 2), cx.elt('WikiLinkMark', end - 2, end)]),
        );
      },
      before: 'Link',
    },
  ],
};

const TAG_RE = /^#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/u;

export const tag: MarkdownConfig = {
  defineNodes: [{ name: 'Tag', style: t.labelName }],
  parseInline: [
    {
      name: 'Tag',
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== HASH) return -1;
        const before = cx.slice(pos - 1, pos);
        if (pos > cx.offset && before && !/[\s(（，。；：、]/.test(before)) return -1;
        const m = TAG_RE.exec(cx.slice(pos, cx.end));
        if (!m) return -1;
        return cx.addElement(cx.elt('Tag', pos, pos + m[0].length));
      },
    },
  ],
};

export const math: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: t.special(t.string) },
    { name: 'InlineMathMark', style: t.processingInstruction },
    { name: 'MathBlock', block: true },
    { name: 'MathBlockMark', style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== DOLLAR || cx.char(pos + 1) === DOLLAR || cx.char(pos - 1) === 92) return -1;
        if (isSpace(cx.char(pos + 1))) return -1;
        for (let i = pos + 1; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === 92) {
            i++;
            continue;
          }
          if (ch === DOLLAR) {
            // 与 Pandoc / Obsidian 一致：结尾 $ 前不能是空白，后面不能紧跟数字
            if (isSpace(cx.char(i - 1)) || i === pos + 1) return -1;
            const after = cx.char(i + 1);
            if (after >= 48 && after <= 57) return -1;
            return cx.addElement(
              cx.elt('InlineMath', pos, i + 1, [cx.elt('InlineMathMark', pos, pos + 1), cx.elt('InlineMathMark', i, i + 1)]),
            );
          }
        }
        return -1;
      },
      before: 'Escape',
    },
  ],
  parseBlock: [
    {
      name: 'MathBlock',
      parse(cx: BlockContext, line: Line) {
        if (!line.text.slice(line.pos).startsWith('$$')) return false;
        const start = cx.lineStart + line.pos;
        const rest = line.text.slice(line.pos + 2);
        const marks: Element[] = [cx.elt('MathBlockMark', start, start + 2)];
        // 单行 $$ x $$
        const close = rest.lastIndexOf('$$');
        if (close >= 0 && rest.trim().length > 2) {
          const endPos = start + 2 + close + 2;
          marks.push(cx.elt('MathBlockMark', endPos - 2, endPos));
          cx.addElement(cx.elt('MathBlock', start, endPos, marks));
          cx.nextLine();
          return true;
        }
        let end = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          const i = line.text.indexOf('$$');
          if (i >= 0 && line.text.slice(i + 2).trim() === '') {
            marks.push(cx.elt('MathBlockMark', cx.lineStart + i, cx.lineStart + i + 2));
            end = cx.lineStart + i + 2;
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('MathBlock', start, end, marks));
        return true;
      },
      before: 'FencedCode',
    },
  ],
};

export const frontmatter: MarkdownConfig = {
  defineNodes: [
    { name: 'Frontmatter', block: true },
    { name: 'FrontmatterMark', style: t.processingInstruction },
  ],
  parseBlock: [
    {
      name: 'Frontmatter',
      parse(cx: BlockContext, line: Line) {
        if (cx.lineStart !== 0 || line.text.trimEnd() !== '---') return false;
        // 和 Obsidian 一致：第一行是 --- 就开始 frontmatter，直到下一个 --- / ...（没有闭合则到文末）
        const marks: Element[] = [cx.elt('FrontmatterMark', 0, 3)];
        let end = 3;
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          if (/^(---|\.\.\.)\s*$/.test(line.text)) {
            marks.push(cx.elt('FrontmatterMark', cx.lineStart, cx.lineStart + 3));
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('Frontmatter', 0, end, marks));
        return true;
      },
      before: 'HorizontalRule',
    },
  ],
};

/** 脚注 `[^label]`：正文里的引用和定义行开头的标签用同一个节点，渲染时按位置区分 */
export const footnote: MarkdownConfig = {
  defineNodes: [
    { name: 'FootnoteRef', style: t.link },
    { name: 'FootnoteMark', style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: 'FootnoteRef',
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== BRACKET || cx.char(pos + 1) !== CARET) return -1;
        const m = /^\[\^([^\]\s]+)\]/.exec(cx.slice(pos, cx.end));
        if (!m) return -1;
        const end = pos + m[0].length;
        return cx.addElement(
          cx.elt('FootnoteRef', pos, end, [cx.elt('FootnoteMark', pos, pos + 2), cx.elt('FootnoteMark', end - 1, end)]),
        );
      },
      before: 'Link',
    },
  ],
};

export const zyriteMarkdown: MarkdownConfig[] = [frontmatter, math, highlight, wikiLink, tag, footnote];
