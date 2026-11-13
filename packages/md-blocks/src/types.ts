import type { Literal, Parent, PhrasingContent } from 'mdast';

/**
 * 原文风格提示，挂在 mdast 节点的 `data.zy` 上。
 * 解析时从源码探测出来；所见即所得把它们存进节点属性，块被编辑后重新序列化时据此沿用原文写法。
 */
export interface ZyHints {
  /** emphasis / strong 的标记符 */
  marker?: '*' | '_';
  /** 无序列表符号 */
  bullet?: '-' | '*' | '+';
  /** 有序列表分隔符 */
  delimiter?: '.' | ')';
  /** 有序列表是否递增编号（false = 全部写成同一个数字） */
  increment?: boolean;
  /** 列表标记后的缩进方式 */
  itemIndent?: 'one' | 'tab';
  /** 标题是否为 setext 写法（下划线 === / ---） */
  setext?: boolean;
  /** 代码块围栏，例如 ``` 或 ~~~~；空串表示缩进式代码块 */
  fence?: string;
  /** 分隔线、硬换行等的原文 */
  markup?: string;
  /** 链接写法：普通 [a](b)、尖括号 <url>、GFM 裸链接 */
  linkKind?: 'inline' | 'autolink' | 'literal';
  /** 表格竖线是否对齐 */
  alignPipes?: boolean;
  /** 表格单元格两侧是否留空格 */
  cellPadding?: boolean;
  /** 表格行首是否有竖线 */
  outerPipes?: boolean;
  /** 表格行尾是否有竖线 */
  trailingPipe?: boolean;
  /** 表格分隔行原文，例如 `|---|:---:|` */
  delimRow?: string;
  /** 文本 / 行内代码的原文（含转义、实体、反引号），内容没改时原样输出 */
  raw?: string;
  /** 原文里这段文本是否位于行首（决定原样输出是否安全） */
  lineStart?: boolean;
}

/** Obsidian 双链 `[[笔记#标题|别名]]`，embed 为 `![[...]]` */
export interface WikiLink extends Literal {
  type: 'wikiLink';
  /** 方括号内的原文，例如 `笔记#标题|别名` */
  value: string;
  embed: boolean;
}

/** `==高亮==` */
export interface Highlight extends Parent {
  type: 'highlight';
  children: PhrasingContent[];
}

/** `#标签`，value 不含 # */
export interface Tag extends Literal {
  type: 'tag';
  value: string;
}

/** 原样输出的一段 Markdown 原文 */
export interface ZyRaw extends Literal {
  type: 'zyRaw';
  value: string;
}

declare module 'mdast' {
  interface Data {
    zy?: ZyHints;
  }
  interface PhrasingContentMap {
    wikiLink: WikiLink;
    highlight: Highlight;
    tag: Tag;
    zyRaw: ZyRaw;
  }
  interface RootContentMap {
    wikiLink: WikiLink;
    highlight: Highlight;
    tag: Tag;
    zyRaw: ZyRaw;
  }
}

/** 整篇文档的默认风格：新写的内容沿用文档里已有的写法 */
export interface MdStyle {
  eol: '\n' | '\r\n';
  bullet: '-' | '*' | '+';
  delimiter: '.' | ')';
  emphasis: '*' | '_';
  strong: '*' | '_';
  fence: string;
  rule: string;
  setext: boolean;
  itemIndent: 'one' | 'tab';
}

export const defaultStyle: MdStyle = {
  eol: '\n',
  bullet: '-',
  delimiter: '.',
  emphasis: '*',
  strong: '*',
  fence: '```',
  rule: '---',
  setext: false,
  itemIndent: 'one',
};
