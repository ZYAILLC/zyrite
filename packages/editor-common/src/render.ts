import type { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import katex from 'katex';

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

/** 读取当前主题的 CSS 变量，给 Mermaid 配色：无填充、细线、文字色描边 */
function themeVariables() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
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
  const bg = color('--z-bg', '#ffffff');
  const text = color('--z-text', '#1d1d1f');
  const muted = color('--z-muted', '#6b6a66');
  const hair = color('--z-hair', '#e8e6e1');
  probe.remove();
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
    fontFamily: v('--z-font-ui', 'sans-serif'),
    fontSize: '13px',
  };
}

async function getMermaid(htmlLabels = true): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  const mermaid = await mermaidPromise;
  const vars = themeVariables();
  const key = JSON.stringify({ vars, htmlLabels });
  if (key !== mermaidThemeKey) {
    mermaidThemeKey = key;
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      themeVariables: vars,
      securityLevel: 'strict',
      htmlLabels,
      flowchart: { htmlLabels },
    });
  }
  return mermaid;
}

/** 渲染 Mermaid 图（按需加载，体积较大） */
export async function renderMermaid(el: HTMLElement, source: string): Promise<void> {
  try {
    const mermaid = await getMermaid();
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
