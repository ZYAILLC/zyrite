import type { EditorHandle } from '@zyrite/editor-common';

/**
 * 当前的编辑器实例（由 components/Editor 维护），供大纲跳转、保存、查找等取用。
 * docId 是这个实例对应的文档：换文档后、新编辑器建好之前，旧实例里还是旧内容，不能拿来当当前文档。
 */
export const activeEditor: { current: EditorHandle | null; docId: number } = { current: null, docId: -1 };

const listeners = new Set<(editor: EditorHandle) => void>();

/** 编辑器重建后（切换模式、换文档）通知，例如查找栏要把查询重新设到新编辑器上 */
export function onEditorReady(fn: (editor: EditorHandle) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setActiveEditor(editor: EditorHandle, docId: number) {
  activeEditor.current = editor;
  activeEditor.docId = docId;
  for (const fn of listeners) fn(editor);
}
