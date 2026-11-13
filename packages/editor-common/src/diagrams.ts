import { themeColorReader } from './render';

/** 渲染成图或表格的代码块语言：预览栏和所见即所得都不当普通代码高亮 */
export const RENDERED_LANGS = new Set(['math', 'mermaid', 'dot', 'graphviz', 'markmap', 'csv', 'tsv']);

/** Graphviz 代码块的语言名 */
export function isGraphvizLang(lang: string | null | undefined): boolean {
  const l = lang?.toLowerCase();
  return l === 'dot' || l === 'graphviz';
}

/* ---------------- Graphviz ---------------- */

export interface DotColors {
  text: string;
  muted: string;
  hair: string;
}

const DOT_FONT = 'Helvetica,Arial,sans-serif';

/**
 * 在图的第一个 `{` 后面插入默认样式（透明背景、主题文字色、细线色），图里自己写的属性在后面，会覆盖这些默认值。
 * 插在同一行，Graphviz 报错时的行号不变。找不到图的开头时原样返回（交给 Graphviz 报错）。
 */
export function themedDot(source: string, c: DotColors): string {
  const head =
    /^(?:\s|\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)*(?:strict\s+)?(?:di)?graph\s*(?:"(?:[^"\\]|\\.)*"|[^\s{"]+)?\s*\{/i.exec(
      source,
    );
  if (!head) return source;
  const font = `fontname="${DOT_FONT}"`;
  const defaults =
    `graph [bgcolor="transparent" color="${c.hair}" fontcolor="${c.text}" fillcolor="${c.hair}" ${font} fontsize=13]; ` +
    `node [color="${c.text}" fontcolor="${c.text}" fillcolor="${c.hair}" ${font} fontsize=13]; ` +
    `edge [color="${c.muted}" fontcolor="${c.muted}" ${font} fontsize=11]; `;
  const at = head[0].length;
  return `${source.slice(0, at)}${defaults}${source.slice(at)}`;
}

function dotColors(): DotColors {
  const { color, done } = themeColorReader();
  const out = {
    text: color('--z-text', '#1d1d1f'),
    muted: color('--z-muted', '#6b6a66'),
    hair: color('--z-hair', '#e8e6e1'),
  };
  done();
  return out;
}

/**
 * Graphviz（DOT）→ SVG 字符串。WASM 按需加载（体积较大）；出错时抛出 Graphviz 的错误信息。
 * 每次都经 Graphviz.load() 取实例：出错后库会卸载重建 WASM 模块，不能缓存旧实例。
 */
export async function renderGraphvizSvg(source: string): Promise<string> {
  const { Graphviz } = await import('@hpcc-js/wasm-graphviz');
  const graphviz = await Graphviz.load();
  const svg = graphviz.dot(themedDot(source, dotColors()), 'svg');
  // 去掉前面的 <?xml?>、DOCTYPE 和注释，只保留 <svg>
  const start = svg.indexOf('<svg');
  return start < 0 ? svg : svg.slice(start);
}

/** 渲染 Graphviz 图；出错时显示错误信息，和 Mermaid 一样 */
export async function renderGraphviz(el: HTMLElement, source: string): Promise<void> {
  try {
    el.innerHTML = await renderGraphvizSvg(source);
    el.classList.remove('mermaid-error');
  } catch (e) {
    el.textContent = e instanceof Error ? e.message : String(e);
    el.classList.add('mermaid-error');
  }
}

/* ---------------- Markmap ---------------- */

type TransformerT = import('markmap-lib/no-plugins').Transformer;
let transformer: TransformerT | undefined;

/** Markmap 转换出来的节点树（只用到 children） */
interface TreeNode {
  children: TreeNode[];
}

/** 思维导图的高度：按叶子节点数估算，160–480px 之间 */
export function markmapHeight(root: TreeNode): number {
  const leaves = (n: TreeNode): number => (n.children.length ? n.children.reduce((s, c) => s + leaves(c), 0) : 1);
  return Math.min(480, Math.max(160, leaves(root) * 28 + 40));
}

/** 分支颜色：主题的语法色和强调色 */
function branchPalette(): string[] {
  const { color, done } = themeColorReader();
  const out = [
    color('--z-accent', '#2f5bea'),
    color('--z-syn-keyword', '#7a3e8e'),
    color('--z-syn-string', '#2f6a3a'),
    color('--z-syn-number', '#8f4b12'),
    color('--z-syn-def', '#24508f'),
    color('--z-syn-type', '#1f6466'),
  ];
  done();
  return out;
}

/**
 * Markmap 思维导图（代码块里写 Markdown 标题、列表）：可以点圆点折叠、展开分支。
 * 不接管滚轮和拖动，正文照常滚动。布局要量节点尺寸，元素还没挂到页面上（或宽度为 0）时，
 * 等它显示出来再画；之后尺寸变化时重新适配大小。
 * 返回的 Promise 在第一次画完（或确定要等元素显示出来）后完成。
 */
export async function renderMarkmap(el: HTMLElement, source: string): Promise<void> {
  try {
    const [{ Transformer }, { Markmap }] = await Promise.all([import('markmap-lib/no-plugins'), import('markmap-view')]);
    if (!transformer) {
      transformer = new Transformer([]);
      // 节点内容不解析 HTML，避免嵌入脚本、事件属性
      transformer.md.set({ html: false });
    }
    const { root } = transformer.transform(source);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'zy-markmap-svg');
    svg.style.height = `${markmapHeight(root)}px`;
    el.replaceChildren(svg);
    el.classList.remove('mermaid-error');

    const palette = branchPalette();
    // 一级分支 → 第几种颜色（按第一次画到的顺序）
    const branches = new Map<string, number>();
    let map: InstanceType<typeof Markmap> | undefined;
    const fail = (e: unknown) => {
      ro?.disconnect();
      el.textContent = e instanceof Error ? e.message : String(e);
      el.classList.add('mermaid-error');
    };
    const draw = () => {
      // 已经被移出页面或隐藏：先不画，等下次显示出来
      if (!svg.isConnected || !svg.getBoundingClientRect().width) return;
      try {
        if (map) {
          void map.fit();
          return;
        }
        const m = new Markmap(svg, {
          autoFit: true,
          // 适配大小时只缩小不放大，字和正文差不多大
          maxInitialScale: 1,
          duration: 300,
          zoom: false,
          pan: false,
          paddingX: 8,
          spacingVertical: 6,
          maxWidth: 280,
          color: (node) => {
            // 根节点用强调色；同一个一级分支用同一种颜色，相邻分支按顺序取不同的颜色
            const branch = node.state?.path?.split('.')[1];
            if (!branch) return palette[0]!;
            let i = branches.get(branch);
            if (i === undefined) branches.set(branch, (i = branches.size));
            return palette[1 + (i % (palette.length - 1))] ?? palette[0]!;
          },
        });
        // d3-zoom 默认从 svg 的 width/height 属性取范围，宽度是百分比、元素又暂时隐藏时会抛错；改成按实际尺寸
        m.zoom.extent(() => [
          [0, 0],
          [svg.clientWidth || 1, svg.clientHeight || 1],
        ]);
        map = m;
        m.setData(root).then(() => m.fit(), fail);
      } catch (e) {
        fail(e);
      }
    };
    // 没有 ResizeObserver 的环境（测试）只画一次
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(draw);
    ro?.observe(svg);
    draw();
  } catch (e) {
    el.textContent = e instanceof Error ? e.message : String(e);
    el.classList.add('mermaid-error');
  }
}
