import {
  addColorSwatches,
  highlightCodeBlocks,
  renderCsv,
  renderEmbed,
  renderGraphvizSvg,
  renderMarkmap,
  renderMath,
  renderMermaidSvg,
  renderTocs,
  replaceMediaImages,
  revealTocTarget,
} from '@zyrite/editor-common';
import { renderHtml } from '@zyrite/md-blocks';
import { type MouseEvent as ReactMouseEvent, useEffect, useRef } from 'react';
import { t } from '../i18n';
import { backend } from '../lib/backend';
import { resolveEmbed } from '../lib/embeds';
import { openLink } from '../lib/document';
import { activeEditor, onEditorReady } from '../lib/editorRef';
import { linkStatus, openWikiLink } from '../lib/linkIndex';
import { activeThemeId, useApp } from '../store';

/** 公式、Mermaid、Graphviz 渲染结果的缓存：每次改动都整篇重新生成 HTML，没变的公式和图直接复用，不闪 */
const mathCache = new Map<string, string>();
const mermaidCache = new Map<string, string>();
const graphvizCache = new Map<string, string>();
const CACHE_LIMIT = 500;
/**
 * Markmap 是可以交互的图（折叠、展开），缓存画好的元素本身，重新渲染时原样搬到新位置，
 * 不闪、折叠状态也保留。数量少，上限也小。
 */
const markmapCache = new Map<string, HTMLElement>();
const MARKMAP_LIMIT = 30;

function remember(cache: Map<string, string>, key: string, value: string) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
}

/** 新元素替换旧元素时带上源码行号，同步滚动要用 */
function replaceKeepLine(old: Element, next: HTMLElement) {
  const line = old.getAttribute('data-line');
  if (line) next.setAttribute('data-line', line);
  old.replaceWith(next);
}

/** Mermaid 一张一张画（同时画多张时 Mermaid 会互相干扰） */
let mermaidQueue: Promise<void> = Promise.resolve();

function render(el: HTMLElement, markdown: string, filePath: string | null, isCurrent: () => boolean, done: () => void) {
  el.innerHTML = renderHtml(markdown, { lineAttrs: true, footnoteLabel: t.footnotes, footnoteBackLabel: t.footnoteBack });
  // `![说明](clip.mp4)`：视频、音频显示播放器，网络地址显示成链接
  replaceMediaImages(el, (src) => backend.resolveImage(src, filePath));
  for (const img of el.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (src) img.src = backend.resolveImage(src, filePath);
  }
  for (const code of el.querySelectorAll<HTMLElement>('code.language-math')) {
    const display = code.classList.contains('math-display');
    const tex = code.textContent ?? '';
    const key = `${display ? 'D' : 'I'}${tex}`;
    const out = document.createElement(display ? 'div' : 'span');
    out.className = display ? 'zy-figure' : 'inline-math';
    const cached = mathCache.get(key);
    if (cached !== undefined) out.innerHTML = cached;
    else {
      renderMath(out, tex, display);
      if (!out.classList.contains('math-error')) remember(mathCache, key, out.innerHTML);
    }
    replaceKeepLine(display ? (code.closest('pre') ?? code) : code, out);
  }
  // `![[图片]]`、`![[笔记]]` 嵌入
  for (const span of el.querySelectorAll<HTMLElement>('span.wikilink.embed')) {
    const out = document.createElement('span');
    if (renderEmbed(out, span.dataset.value ?? span.dataset.target ?? '', resolveEmbed)) span.replaceWith(out);
  }
  // 链接到库里不存在的笔记：和编辑器一样显示成虚线
  for (const a of el.querySelectorAll<HTMLElement>('a.wikilink')) {
    if (linkStatus(a.dataset.target ?? '') === 'missing') a.classList.add('missing');
  }
  // `[TOC]` 目录、行内代码里颜色值的色块
  renderTocs(el);
  addColorSwatches(el);
  // 代码块语法高亮：有缓存的立即上色，其余加载语言后再上色
  void highlightCodeBlocks(el, isCurrent);
  const todo: [HTMLElement, string][] = [];
  for (const code of el.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
    const source = code.textContent ?? '';
    const fig = document.createElement('div');
    fig.className = 'zy-figure zy-mermaid';
    const cached = mermaidCache.get(source);
    if (cached !== undefined) fig.innerHTML = cached;
    else todo.push([fig, source]);
    replaceKeepLine(code.parentElement ?? code, fig);
  }
  // CSV / TSV 表格：同步生成，很快，不用缓存
  for (const code of el.querySelectorAll<HTMLElement>('pre > code.language-csv, pre > code.language-tsv')) {
    const fig = document.createElement('div');
    fig.className = 'zy-figure zy-figure-plain zy-csv';
    renderCsv(fig, code.textContent ?? '', code.classList.contains('language-tsv') ? '\t' : ',');
    replaceKeepLine(code.parentElement ?? code, fig);
  }
  // Markmap：同一份源码复用缓存的元素（同一篇里出现两次时第二个重新画）
  const usedMaps = new Set<HTMLElement>();
  for (const code of el.querySelectorAll<HTMLElement>('pre > code.language-markmap')) {
    const source = code.textContent ?? '';
    let fig = markmapCache.get(source);
    const fresh = !fig || usedMaps.has(fig);
    if (!fig || fresh) {
      fig = document.createElement('div');
      fig.className = 'zy-figure zy-markmap';
    }
    usedMaps.add(fig);
    replaceKeepLine(code.parentElement ?? code, fig);
    if (fresh) {
      if (markmapCache.size >= MARKMAP_LIMIT) markmapCache.delete(markmapCache.keys().next().value as string);
      markmapCache.set(source, fig);
      void renderMarkmap(fig, source);
    }
  }
  // Graphviz：WASM 第一次要加载，之后同步出图；画完的 SVG 按源码缓存
  const graphs: Promise<void>[] = [];
  for (const code of el.querySelectorAll<HTMLElement>('pre > code.language-dot, pre > code.language-graphviz')) {
    const source = code.textContent ?? '';
    const fig = document.createElement('div');
    fig.className = 'zy-figure zy-graphviz';
    const cached = graphvizCache.get(source);
    if (cached !== undefined) fig.innerHTML = cached;
    else
      graphs.push(
        renderGraphvizSvg(source).then(
          (svg) => {
            remember(graphvizCache, source, svg);
            if (isCurrent()) fig.innerHTML = svg;
          },
          (e: unknown) => {
            fig.textContent = e instanceof Error ? e.message : String(e);
            fig.classList.add('mermaid-error');
          },
        ),
      );
    replaceKeepLine(code.parentElement ?? code, fig);
  }
  // 图画完后高度变了，再对齐一次滚动位置
  if (graphs.length) void Promise.all(graphs).then(() => isCurrent() && done());
  if (!todo.length) return done();
  mermaidQueue = mermaidQueue.then(async () => {
    for (const [fig, source] of todo) {
      if (!isCurrent()) return;
      try {
        const svg = await renderMermaidSvg(source);
        remember(mermaidCache, source, svg);
        fig.innerHTML = svg;
      } catch (e) {
        fig.textContent = e instanceof Error ? e.message : String(e);
        fig.classList.add('mermaid-error');
      }
    }
    if (isCurrent()) done();
  });
}

/**
 * 预览栏（原文 + 预览分栏时的右栏）：只读，渲染当前全文，和原文同步滚动。
 * 内容是 store 里防抖后的 text，打字停 250ms 后刷新。
 */
export function Preview() {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const text = useApp((s) => s.text);
  const filePath = useApp((s) => s.filePath);
  const typoraTheme = useApp((s) => s.typoraTheme);
  // 关掉"加载远程图片"后要重新渲染，已经显示的网络图片才会去掉
  const remoteImages = useApp((s) => s.image.remote);
  // `![[…]]` 嵌入要等文件树和笔记名单加载好才能解析，加载后重新渲染
  const tree = useApp((s) => s.tree);
  const indexVersion = useApp((s) => s.indexVersion);
  const themeKey = useApp((s) => `${activeThemeId(s.themePref, s.systemDark)}:${s.typoraTheme ?? ''}`);
  // 下标设置改变解析方式，改了要重新渲染
  const subscript = useApp((s) => s.subscript);
  const sync = useScrollSync(scroller, content);

  // 换主题后 Mermaid、Graphviz、Markmap 的配色跟着变，缓存作废
  const lastTheme = useRef(themeKey);
  if (lastTheme.current !== themeKey) {
    lastTheme.current = themeKey;
    mermaidCache.clear();
    graphvizCache.clear();
    markmapCache.clear();
  }

  const generation = useRef(0);
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const gen = ++generation.current;
    render(el, text, filePath, () => gen === generation.current, () => sync.fromSource());
    // 先按已经有的内容对齐一次，Mermaid 画完后再对齐一次
    sync.fromSource();
  }, [text, filePath, themeKey, remoteImages, tree, indexVersion, subscript, sync]);

  const onClick = (e: ReactMouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains('zy-toc-link')) {
      if (content.current) revealTocTarget(content.current, a);
      return;
    }
    if (a.classList.contains('wikilink')) {
      const target = a.dataset.target ?? '';
      void (useApp.getState().folder ? openWikiLink(target) : openLink(target, 'wikilink'));
      return;
    }
    const href = a.getAttribute('href');
    if (!href) return;
    // 脚注之类的文内跳转
    if (href.startsWith('#')) {
      content.current?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({ block: 'center' });
      return;
    }
    void openLink(href, 'url');
  };

  return (
    <div ref={scroller} className={`preview-scroll${typoraTheme ? ' zy-typora' : ''}`}>
      {/* 和编辑器一样用 #write，Typora 主题对预览也生效；纯源码编辑器没有 #write，不会重复 */}
      <div ref={content} id="write" className="zy-doc zy-preview" onClick={onClick} />
    </div>
  );
}

/** 源码滚动位置 ↔ 预览滚动位置：两边各自的块起点配成一对对锚点，锚点之间按比例插值 */
type Pairs = [source: number, preview: number][];

function interpolate(pairs: Pairs, x: number, from: 0 | 1): number {
  const to = from === 0 ? 1 : 0;
  for (let i = 1; i < pairs.length; i++) {
    const a = pairs[i - 1]!;
    const b = pairs[i]!;
    if (x <= b[from] || i === pairs.length - 1) {
      const span = b[from] - a[from];
      const k = span > 0 ? Math.min(1, Math.max(0, (x - a[from]) / span)) : 0;
      return a[to] + k * (b[to] - a[to]);
    }
  }
  return x;
}

/**
 * 同步滚动。原文的滚动容器是 .editor-scroll（Editor 挂在里面），预览是自己的 .preview-scroll。
 * 谁先被用户滚动谁就是"主动方"，另一边跟着走；被动方因此触发的 scroll 事件不再回传，避免来回抖。
 */
function useScrollSync(previewRef: React.RefObject<HTMLDivElement | null>, contentRef: React.RefObject<HTMLDivElement | null>) {
  const api = useRef<{ fromSource: () => void }>({ fromSource: () => {} });

  useEffect(() => {
    const preview = previewRef.current;
    const content = contentRef.current;
    const source = document.querySelector<HTMLElement>('.editor-scroll');
    if (!preview || !content || !source) return;

    // 记下"我们替它滚到了哪里"：被动方收到的 scroll 事件如果正好停在这个位置，就是我们自己滚的回声，不再回传。
    // 不用计时器判断，窗口在后台、帧率很低时也不会来回拉扯。
    const expected = new Map<HTMLElement, number>();
    const scrollTo = (el: HTMLElement, top: number) => {
      const v = Math.round(Math.min(Math.max(0, top), el.scrollHeight - el.clientHeight));
      if (Math.abs(el.scrollTop - v) < 1) return;
      expected.set(el, v);
      el.scrollTop = v;
    };
    const isEcho = (el: HTMLElement) => {
      const v = expected.get(el);
      expected.delete(el);
      return v !== undefined && Math.abs(el.scrollTop - v) <= 1.5;
    };

    // 预览里各块相对内容顶部的位置：只在内容或尺寸变化后重新量
    let previewTops: [line: number, top: number][] | null = null;
    const measurePreview = () => {
      const base = preview.getBoundingClientRect().top - preview.scrollTop;
      previewTops = [];
      for (const el of content.querySelectorAll<HTMLElement>(':scope > [data-line]')) {
        previewTops.push([Number(el.dataset.line), el.getBoundingClientRect().top - base]);
      }
      return previewTops;
    };

    const pairs = (): Pairs | null => {
      const ed = activeEditor.current;
      if (!ed?.lineRect) return null;
      const tops = previewTops ?? measurePreview();
      const base = source.getBoundingClientRect().top - source.scrollTop;
      const out: Pairs = [[0, 0]];
      for (const [line, top] of tops) {
        const r = ed.lineRect(line);
        if (!r) continue;
        const s = r.top - base;
        const last = out[out.length - 1]!;
        // 只保留两边都往下走的锚点，插值才是单调的
        if (s > last[0] && top >= last[1]) out.push([s, top]);
      }
      const last = out[out.length - 1]!;
      const end: [number, number] = [source.scrollHeight - source.clientHeight, preview.scrollHeight - preview.clientHeight];
      if (end[0] > last[0] && end[1] >= last[1]) out.push(end);
      return out;
    };

    const fromSource = () => {
      const p = pairs();
      if (p) scrollTo(preview, interpolate(p, source.scrollTop, 0));
    };
    const fromPreview = () => {
      const p = pairs();
      if (p) scrollTo(source, interpolate(p, preview.scrollTop, 1));
    };

    const onSource = () => {
      if (!isEcho(source)) fromSource();
    };
    const onPreview = () => {
      if (!isEcho(preview)) fromPreview();
    };
    source.addEventListener('scroll', onSource, { passive: true });
    preview.addEventListener('scroll', onPreview, { passive: true });

    // 内容重新渲染、图片加载完、窗口或栏宽变化：预览各块的位置要重新量
    const invalidate = () => {
      previewTops = null;
    };
    const ro = new ResizeObserver(() => {
      invalidate();
      fromSource();
    });
    ro.observe(content);
    ro.observe(preview);
    const offReady = onEditorReady(() => requestAnimationFrame(fromSource));

    api.current.fromSource = () => {
      invalidate();
      fromSource();
    };
    return () => {
      source.removeEventListener('scroll', onSource);
      preview.removeEventListener('scroll', onPreview);
      ro.disconnect();
      offReady();
      api.current.fromSource = () => {};
    };
  }, [previewRef, contentRef]);

  // 返回稳定的对象，放进 effect 依赖里不会触发重渲染
  const stable = useRef({ fromSource: () => api.current.fromSource() });
  return stable.current;
}
