/**
 * 行内代码里的颜色值（`#E0A040`、`rgb(47, 91, 234)`、`hsl(150 60% 40%)` 等）后面显示一个色块，和 GitHub 一样。
 * 只认整段代码就是一个颜色值的情况。
 */
const COLOR =
  /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]{1,60}\))$/i;

/** 是颜色值就返回规范后的写法（去掉首尾空白），否则返回 null */
export function cssColor(text: string): string | null {
  const t = text.trim();
  if (!COLOR.test(t)) return null;
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && !CSS.supports('color', t)) return null;
  return t;
}

/** 色块元素 */
export function colorSwatch(color: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'zy-swatch';
  el.style.background = color;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** 给元素里的行内代码加上色块（代码块里的不算） */
export function addColorSwatches(root: HTMLElement) {
  for (const code of root.querySelectorAll('code')) {
    if (code.closest('pre') || code.querySelector('.zy-swatch')) continue;
    const color = cssColor(code.textContent ?? '');
    if (color) code.append(colorSwatch(color));
  }
}
