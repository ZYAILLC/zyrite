import { fromHtml } from 'hast-util-from-html';
import { toMdast } from 'hast-util-to-mdast';
import type { Root } from 'mdast';
import { stringifyTree } from './stringify';
import { defaultStyle, type MdStyle } from './types';

/** 粘贴的 HTML 转成 Markdown（粘贴 HTML 转 Markdown） */
export function htmlToMarkdown(html: string, style: MdStyle = defaultStyle): string {
  const hast = fromHtml(html, { fragment: true });
  const mdast = toMdast(hast) as Root;
  return stringifyTree(mdast, { ...style, eol: '\n' }).replace(/\n+$/, '');
}
