import { outline, splitBlocks } from '@zyrite/md-blocks';
import { useMemo } from 'react';
import { t } from '../i18n';
import { useApp } from '../store';
import { activeEditor } from '../lib/editorRef';
import { isMarkdownDoc } from '../lib/paths';

/** 左栏"目录"页：文档的标题，按层级缩进，点击跳转。页签已经写了"目录"，这里不再加标题 */
export function Outline() {
  const text = useApp((s) => s.text);
  // 文本文件（YAML、日志等）不按 Markdown 解析：`# 注释` 不是标题，大日志也不用每次都解析
  const markdown = useApp((s) => isMarkdownDoc(s.filePath));
  const items = useMemo(() => (markdown ? outline(splitBlocks(text)) : []), [text, markdown]);
  const minDepth = items.reduce((m, it) => Math.min(m, it.depth), 6);

  return (
    <section aria-label={t.outline}>
      {items.length === 0 ? (
        <p className="muted">{markdown ? t.outlineEmpty : t.outlineText}</p>
      ) : (
        <ul className="outline">
          {items.map((it) => (
            <li key={it.offset} style={{ paddingLeft: `${(it.depth - minDepth) * 12}px` }}>
              <button
                type="button"
                className={it.depth === minDepth ? 'outline-top' : undefined}
                onClick={() => activeEditor.current?.revealOffset(it.offset)}
              >
                {it.text || '—'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
