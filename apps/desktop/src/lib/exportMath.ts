// 导出用的公式渲染：MathJax 输出纯路径的 SVG（不依赖字体），HTML 里直接内嵌，Word 里画成 PNG。
// 只在导出时按需加载（体积较大），平时编辑用 KaTeX。
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { SVG } from 'mathjax-full/js/output/svg.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const doc = mathjax.document('', {
  InputJax: new TeX({ packages: AllPackages.filter((p) => p !== 'bussproofs') }),
  OutputJax: new SVG({ fontCache: 'none' }),
});

/** TeX → <svg>（宽高单位是 ex）；出错时返回 null */
export function texToSvg(tex: string, display: boolean): string | null {
  try {
    const node = doc.convert(tex, { display });
    const svg = adaptor.innerHTML(node);
    if (/data-mjx-error|merror/.test(svg)) return null;
    return svg;
  } catch {
    return null;
  }
}
