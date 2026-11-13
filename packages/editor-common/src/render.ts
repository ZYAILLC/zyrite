import type { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import katex from 'katex';
// 化学式 \ce{…}、\pu{…}（mhchem 扩展，注册到 KaTeX 上）；导出用的 MathJax 自带这个扩展
import 'katex/contrib/mhchem';

/** 用 KaTeX 渲染公式；出错时显示原文和错误，不抛异常 */
export function renderMath(el: HTMLElement, tex: string, displayMode: boolean) {
  try {
    katex.render(tex, el, { displayMode, throwOnError: false, output: 'htmlAndMathml' });
    el.classList.remove('math-error');
  } catch (e) {
    el.textContent = tex;
    el.classList.add('math-error');
    el.title = String(e);
  }
}

type Mermaid = typeof import('mermaid').default;
let mermaidPromise: Promise<Mermaid> | undefined;
let mermaidSeq = 0;
let mermaidThemeKey = '';

/** 两个 #rrggbb 按比例混合：t=0 是 a，t=1 是 b */
export function mixHex(a: string, b: string, t: number): string {
  const rgb = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) || 0);
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((n, i) => Math.round(n + ((y[i] ?? 0) - n) * t).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 饼图的 12 种扇区颜色：先用主题的语法色和强调色（各不相同、深浅一致），
 * 用完后把同一组颜色往文字色混一些再用一轮（浅色主题更深、深色主题更浅），扇区上的字仍然看得清
 */
export function piePalette(base: readonly string[], text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const c = base[i % base.length] ?? text;
    out.push(i < base.length ? c : mixHex(c, text, 0.35));
  }
  return out;
}

/** 甘特图按正文宽度画（默认按整个窗口宽度画，再缩小到正文里，字会很小），取 40 的倍数，少重新初始化几次 */
function ganttWidth(el?: HTMLElement): number {
  const w = el?.isConnected ? el.clientWidth : 0;
  return w >= 320 ? Math.min(1200, Math.round(w / 40) * 40) : 720;
}

/**
 * 把主题的 CSS 变量算成 #rrggbb（Mermaid、Graphviz、Markmap 的配色只认这种写法）。
 * 返回读取函数；用完调用 done() 清理临时元素。
 */
export function themeColorReader(): { color: (name: string, fallback: string) => string; done: () => void } {
  // 变量里可能是 color-mix() 等写法（Typora 主题时），Mermaid 解析不了，先让浏览器算成 rgb()
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.append(probe);
  // 算出来的可能还是 color(srgb …)（WebKit），再画到 1×1 的 canvas 上读回像素，得到 #rrggbb
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const hex = (c: string, fallback: string) => {
    if (!ctx) return fallback;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = fallback;
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  };
  const color = (name: string, fallback: string) => {
    probe.style.color = fallback;
    probe.style.color = `var(${name}, ${fallback})`;
    return hex(getComputedStyle(probe).color || fallback, fallback);
  };
  return { color, done: () => probe.remove() };
}

/** 读取当前主题的 CSS 变量，给 Mermaid 配色：无填充、细线、文字色描边；饼图扇区用语法色区分 */
function themeVariables() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const { color, done } = themeColorReader();
  const bg = color('--z-bg', '#ffffff');
  const text = color('--z-text', '#1d1d1f');
  const muted = color('--z-muted', '#6b6a66');
  const hair = color('--z-hair', '#e8e6e1');
  // 顺序按色相错开；注释色（灰）放最后，深色主题里它和 muted 一样
  const pies = piePalette(
    [
      color('--z-syn-keyword', '#7a3e8e'),
      color('--z-syn-string', '#2f6a3a'),
      color('--z-syn-number', '#8f4b12'),
      color('--z-syn-def', '#24508f'),
      color('--z-syn-type', '#1f6466'),
      color('--z-accent', '#2f5bea'),
      color('--z-syn-comment', '#5f646a'),
    ],
    text,
  );
  done();
  return {
    background: bg,
    primaryColor: bg,
    primaryTextColor: text,
    primaryBorderColor: text,
    secondaryColor: bg,
    tertiaryColor: bg,
    lineColor: muted,
    textColor: text,
    mainBkg: bg,
    nodeBorder: text,
    clusterBkg: bg,
    clusterBorder: hair,
    actorBkg: bg,
    actorBorder: text,
    actorTextColor: text,
    signalColor: muted,
    signalTextColor: text,
    noteBkgColor: bg,
    noteBorderColor: hair,
    ...Object.fromEntries(pies.map((c, i) => [`pie${i + 1}`, c])),
    // 扇区之间用背景色隔开；扇区上的百分比用背景色（语法色在浅色主题偏深、深色主题偏浅，都对得上）
    pieStrokeColor: bg,
    pieStrokeWidth: '1.5px',
    pieOuterStrokeColor: hair,
    pieOuterStrokeWidth: '1px',
    pieOpacity: '0.9',
    pieSectionTextColor: bg,
    pieSectionTextSize: '12px',
    pieTitleTextColor: text,
    pieTitleTextSize: '15px',
    pieLegendTextColor: text,
    pieLegendTextSize: '13px',
    fontFamily: v('--z-font-ui', 'sans-serif'),
    fontSize: '13px',
  };
}

async function getMermaid(htmlLabels = true, width = 720): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  const mermaid = await mermaidPromise;
  const vars = themeVariables();
  const key = JSON.stringify({ vars, htmlLabels, width });
  if (key !== mermaidThemeKey) {
    mermaidThemeKey = key;
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      themeVariables: vars,
      securityLevel: 'strict',
      htmlLabels,
      flowchart: { htmlLabels },
      // 甘特图：按正文宽度画，字和正文里其他图差不多大；左边留出分组名的位置
      gantt: {
        useWidth: width,
        fontSize: 13,
        sectionFontSize: 13,
        barHeight: 22,
        barGap: 6,
        leftPadding: 110,
        rightPadding: 60,
        // 默认的 2026-11-18 太长，刻度挤在一起；图里自己写了 axisFormat 时以图里的为准
        axisFormat: '%m-%d',
      },
    });
  }
  return mermaid;
}

/** 渲染 Mermaid 图（按需加载，体积较大） */
export async function renderMermaid(el: HTMLElement, source: string): Promise<void> {
  try {
    const mermaid = await getMermaid(true, ganttWidth(el));
    const { svg } = await mermaid.render(`zy-mermaid-${++mermaidSeq}`, source);
    el.innerHTML = svg;
    el.classList.remove('mermaid-error');
  } catch (e) {
    el.textContent = e instanceof Error ? e.message : String(e);
    el.classList.add('mermaid-error');
  }
}

/**
 * Mermaid → SVG 字符串（导出用）。htmlLabels 为 false 时文字是 SVG 的 <text>，
 * 不用 foreignObject，可以画到 canvas 上转 PNG（Word 里用图片）
 */
export async function renderMermaidSvg(source: string, htmlLabels = true): Promise<string> {
  const mermaid = await getMermaid(htmlLabels);
  try {
    return (await mermaid.render(`zy-mermaid-${++mermaidSeq}`, source)).svg;
  } finally {
    // 下次在编辑器里渲染时换回默认设置
    if (!htmlLabels) mermaidThemeKey = '';
  }
}

/** 代码块语言（@codemirror/language-data，覆盖 100+ 种，按需加载） */
export function findLanguage(name: string | null | undefined): LanguageDescription | null {
  if (!name) return null;
  const n = name.toLowerCase();
  return (
    languages.find((l) => l.name.toLowerCase() === n || l.alias.includes(n) || l.extensions.includes(n)) ?? null
  );
}

export { languages };
