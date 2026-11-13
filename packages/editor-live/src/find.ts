import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  searchPanelOpen,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import type { FindAdapter, FindQuery } from '@zyrite/editor-common';

/**
 * 查找替换：用 CodeMirror 的搜索状态和一个不显示的面板，界面是应用自己的查找栏。
 * 源码编辑器和文本文件编辑器共用。
 */
export function searchAdapter(view: EditorView): FindAdapter {
  function stats(): { count: number; current: number } {
    const query = getSearchQuery(view.state);
    if (!query.valid) return { count: 0, current: 0 };
    const { from, to } = view.state.selection.main;
    let count = 0;
    let current = 0;
    const cursor = query.getCursor(view.state);
    for (let r = cursor.next(); !r.done && count < 10000; r = cursor.next()) {
      count++;
      if (r.value.from === from && r.value.to === to) current = count;
    }
    return { count, current };
  }

  return {
    setQuery(q: FindQuery) {
      const query = new SearchQuery({
        search: q.search,
        replace: q.replace,
        caseSensitive: q.caseSensitive,
        regexp: q.regexp,
      });
      if (!searchPanelOpen(view.state)) openSearchPanel(view);
      view.dispatch({ effects: setSearchQuery.of(query) });
      return stats();
    },
    next() {
      if (getSearchQuery(view.state).valid) findNext(view);
      return stats();
    },
    prev() {
      if (getSearchQuery(view.state).valid) findPrevious(view);
      return stats();
    },
    replace() {
      if (getSearchQuery(view.state).valid) replaceNext(view);
      return stats();
    },
    replaceAll() {
      if (!getSearchQuery(view.state).valid) return 0;
      const before = stats().count;
      replaceAll(view);
      return before;
    },
    close() {
      closeSearchPanel(view);
      view.focus();
    },
  };
}
