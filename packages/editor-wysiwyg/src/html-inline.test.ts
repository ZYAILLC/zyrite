import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { htmlInline, openTagAttrs, safeStyle } from './html-inline';
import { BlockSerializer } from './serializer';

describe('openTagAttrs', () => {
  it('span 的颜色样式保留', () => {
    expect(openTagAttrs('<span style="color:#d33">')).toEqual({
      tag: 'span',
      attrs: { nodeName: 'span', class: 'zy-html', style: 'color: #d33' },
    });
  });

  it('font color 转成样式，b 用 strong', () => {
    expect(openTagAttrs('<font color="blue">')?.attrs.style).toBe('color: blue');
    expect(openTagAttrs('<b>')?.attrs.nodeName).toBe('strong');
    expect(openTagAttrs('<kbd>')?.attrs.nodeName).toBe('kbd');
  });

  it('不认识的标签、闭合标签、自闭合标签返回 null', () => {
    expect(openTagAttrs('<script>')).toBeNull();
    expect(openTagAttrs('<div>')).toBeNull();
    expect(openTagAttrs('</span>')).toBeNull();
    expect(openTagAttrs('<br/>')).toBeNull();
  });
});

describe('safeStyle', () => {
  it('只留文字相关的属性，去掉 url() 和定位', () => {
    expect(safeStyle('color: red; position: fixed; background: url(http://x/y.png); font-weight: 700')).toBe(
      'color: red; font-weight: 700',
    );
  });
});

describe('htmlInline 装饰', () => {
  const setup = (md: string) => {
    const doc = new BlockSerializer(md).doc;
    return EditorState.create({ doc, plugins: [htmlInline()] });
  };

  it('成对的标签给中间文字加装饰，标签本身隐藏', () => {
    const state = setup('a <span style="color:red">red</span> b <kbd>K</kbd>\n');
    const plugin = state.plugins[0]!;
    const set = plugin.getState(state) as import('prosemirror-view').DecorationSet;
    const found = set.find();
    const inline = found.filter((d) => (d as unknown as { type: { attrs: { nodeName?: string } } }).type.attrs.nodeName);
    expect(inline.map((d) => (d as unknown as { type: { attrs: { nodeName: string } } }).type.attrs.nodeName)).toEqual([
      'span',
      'kbd',
    ]);
    const tags = found.filter((d) => (d as unknown as { type: { attrs: { class?: string } } }).type.attrs.class?.startsWith('zy-html-tag'));
    expect(tags).toHaveLength(4);
  });

  it('光标在范围里时标签显示出来', () => {
    let state = setup('a <u>under</u> b\n');
    const plugin = state.plugins[0]!;
    const inside = state.doc.textContent.indexOf('under');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, inside + 3)));
    const set = plugin.getState(state) as import('prosemirror-view').DecorationSet;
    const active = set
      .find()
      .filter((d) => (d as unknown as { type: { attrs: { class?: string } } }).type.attrs.class?.includes('zy-html-tag-active'));
    expect(active).toHaveLength(2);
  });

  it('只有开标签、没有闭标签：不加装饰', () => {
    const state = setup('a <span style="color:red">red\n');
    const set = state.plugins[0]!.getState(state) as import('prosemirror-view').DecorationSet;
    expect(set.find()).toHaveLength(0);
  });
});
