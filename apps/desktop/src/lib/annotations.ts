import { type Anchor, type AnnotationMark, locateAnchor } from '@zyrite/editor-common';
import { useApp } from '../store';
import type { Annotation, AnnotationStatus } from './backend';
import { deps } from './document';
import { activeEditor } from './editorRef';
import { isMarkdownDoc } from './paths';
import { relInVault } from './vault';

/**
 * 给 Agent 的批注：存在 `.zyrite/annotations/`，不写进 md 原文。
 * 状态：open（待 Agent 处理）→ changed（Agent 已修改，附回复）→ resolved（已解决）；
 * 待处理的批注在原文里找不到锚点时显示"位置已失效"（orphaned，读取时算，不存）。
 */

export type ShownStatus = AnnotationStatus | 'orphaned';

/** 用户写的批注和追问，thread 里记成 user，显示为"你" */
export const USER = 'user';

let loadSeq = 0;

export async function loadAnnotations(): Promise<void> {
  const seq = ++loadSeq;
  const { filePath, folder } = useApp.getState();
  // 批注只用于 Markdown
  if (!filePath || !folder || relInVault(filePath) === null || !isMarkdownDoc(filePath)) {
    useApp.setState({ annotations: [] });
    return;
  }
  try {
    const list = await deps.backend.annotationsGet(filePath);
    if (seq === loadSeq && useApp.getState().filePath === filePath) useApp.setState({ annotations: list });
  } catch {
    // 读不到就当没有
  }
}

/**
 * 显示的状态：只有"待处理"的批注找不到位置时才算"位置已失效"。
 * Agent 按批注改了原文，锚点的文字自然就没了，这时应该显示"Agent 已修改"等用户确认。
 */
export function shownStatus(a: Annotation, text: string): ShownStatus {
  if (a.status === 'open' && !locateAnchor(text, a.anchor)) return 'orphaned';
  return a.status;
}

/** 给编辑器标出来的批注，编号按创建顺序 */
export function marksFor(list: readonly Annotation[]): AnnotationMark[] {
  return list.map((a, i) => ({ id: a.id, n: i + 1, anchor: a.anchor, resolved: a.status === 'resolved' }));
}

/** 把当前的批注标到编辑器上 */
export function applyMarks() {
  activeEditor.current?.setAnnotations(marksFor(useApp.getState().annotations));
}

async function save(list: Annotation[]) {
  const { filePath } = useApp.getState();
  if (!filePath) return;
  useApp.setState({ annotations: list });
  applyMarks();
  try {
    await deps.backend.annotationsSave(filePath, list);
  } catch (e) {
    useApp.getState().setNotice({ text: String(e instanceof Error ? e.message : e), error: true });
  }
}

function update(id: string, fn: (a: Annotation) => Annotation) {
  return save(useApp.getState().annotations.map((a) => (a.id === id ? fn(a) : a)));
}

const newId = () => `an_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function createAnnotation(anchor: Anchor, body: string, assignee: string): Promise<void> {
  const { filePath } = useApp.getState();
  const rel = filePath ? relInVault(filePath) : null;
  if (!rel || !body.trim()) return;
  const a: Annotation = {
    id: newId(),
    file: rel,
    anchor,
    body: body.trim(),
    assignee,
    status: 'open',
    thread: [],
    createdAt: String(Date.now()),
  };
  await save([...useApp.getState().annotations, a]);
}

/** 用户继续追问：加进对话，状态回到待处理 */
export function followUp(id: string, text: string) {
  if (!text.trim()) return Promise.resolve();
  return update(id, (a) => ({
    ...a,
    status: 'open',
    thread: [...a.thread, { by: USER, at: String(Date.now()), text: text.trim() }],
  }));
}

export const setStatus = (id: string, status: AnnotationStatus) => update(id, (a) => ({ ...a, status }));
export const setAssignee = (id: string, assignee: string) => update(id, (a) => ({ ...a, assignee }));
export const deleteAnnotation = (id: string) => save(useApp.getState().annotations.filter((a) => a.id !== id));

/** 时间：毫秒数字符串或 RFC 3339 都接受 */
export function parseTime(at: string): number {
  const n = Number(at);
  return Number.isFinite(n) && n > 1e11 ? n : Date.parse(at);
}
