import { outline, splitBlocks } from '@zyrite/md-blocks';
import { useMemo } from 'react';
import { t } from '../i18n';
import { useApp } from '../store';
import { activeEditor } from '../lib/editorRef';

/** 左栏"目录"页：文档的标题，按层级缩进，点击跳转。页签已经写了"目录"，这里不再加标题 */
export function Outline() {
  const text = useApp((s) => s.text);
  const items = useMemo(() => outline(splitBlocks(text)), [text]);
  const minDepth = items.reduce((m, it) => Math.min(m, it.depth), 6);

  return (
    <section aria-label={t.outline}>
      {items.length === 0 ? (
        <p className="muted">{t.outlineEmpty}</p>
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
