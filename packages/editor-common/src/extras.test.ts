// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { addColorSwatches, cssColor } from './color';
import { renderMath } from './render';
import { isTocMarker, renderTocs } from './toc';

describe('cssColor', () => {
  it('认十六进制、rgb、hsl 等写法', () => {
    expect(cssColor('#E0A040')).toBe('#E0A040');
    expect(cssColor(' #fff ')).toBe('#fff');
    expect(cssColor('rgb(47, 91, 234)')).toBe('rgb(47, 91, 234)');
    expect(cssColor('hsl(150 60% 40%)')).toBe('hsl(150 60% 40%)');
  });

  it('其他代码不算', () => {
    expect(cssColor('#hash')).toBeNull();
    expect(cssColor('npm install')).toBeNull();
    expect(cssColor('red')).toBeNull();
    expect(cssColor('#12345')).toBeNull();
  });

  it('只给行内代码加色块，代码块里的不加', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p><code>#E0A040</code> <code>x</code></p><pre><code>#E0A040</code></pre>';
    addColorSwatches(el);
    expect(el.querySelectorAll('.zy-swatch')).toHaveLength(1);
    expect(el.querySelector('p code .zy-swatch')).not.toBeNull();
  });
});

describe('[TOC]', () => {
  it('识别 [TOC] 段落', () => {
    expect(isTocMarker('[TOC]')).toBe(true);
    expect(isTocMarker(' [toc] ')).toBe(true);
    expect(isTocMarker('[TOC] more')).toBe(false);
  });

  it('换成按层级缩进的标题列表', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p data-line="1">[TOC]</p><h1>A</h1><h2>B</h2><h3>C</h3>';
    renderTocs(el);
    const links = [...el.querySelectorAll<HTMLElement>('.zy-toc-link')];
    expect(links.map((a) => a.textContent)).toEqual(['A', 'B', 'C']);
    expect(links.map((a) => a.style.paddingLeft)).toEqual(['0px', '16px', '32px']);
    expect(el.querySelector('nav')?.getAttribute('data-line')).toBe('1');
  });
});

describe('化学式', () => {
  it('\\ce 能渲染，不报错', () => {
    const el = document.createElement('span');
    renderMath(el, '\\ce{H2O + CO2 -> H2CO3}', false);
    expect(el.classList.contains('math-error')).toBe(false);
    expect(el.querySelector('.katex-error')).toBeNull();
  });
});
