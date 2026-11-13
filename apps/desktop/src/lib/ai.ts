import { useApp } from '../store';
import type { ProviderConfig } from './aiConfig';
import { deps } from './document';

export * from './aiConfig';

/**
 * 内置 AI：用户自带 key 或本地模型，请求直接发给服务商，不经过任何 Zyrite 或 z-y.ai 的服务器。
 * key 存在系统钥匙串里（Rust 侧），界面只知道"有没有"。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamHandlers {
  onDelta: (delta: string, full: string) => void;
  onDone?: (full: string) => void;
  onError?: (message: string) => void;
}

let seq = 0;

/** 流式对话，返回取消函数 */
export function streamChat(p: ProviderConfig, messages: ChatMessage[], h: StreamHandlers): () => void {
  const id = `ai_${Date.now().toString(36)}_${++seq}`;
  let full = '';
  let off: (() => void) | null = null;
  let finished = false;
  void deps.backend
    .onAiEvent((e) => {
      if (e.id !== id || finished) return;
      if (e.delta) {
        full += e.delta;
        h.onDelta(e.delta, full);
      }
      if (e.done) {
        finished = true;
        off?.();
        if (e.error) h.onError?.(e.error);
        else h.onDone?.(e.text ?? full);
      }
    })
    .then((unlisten) => {
      off = unlisten;
      if (finished) unlisten();
      else void deps.backend.aiChat(id, p, p.id, messages).catch((err) => {
        finished = true;
        unlisten();
        h.onError?.(String(err instanceof Error ? err.message : err));
      });
    });
  return () => {
    if (finished) return;
    finished = true;
    off?.();
    void deps.backend.aiCancel(id);
  };
}

/** 一次性拿完整回答 */
export function complete(p: ProviderConfig, messages: ChatMessage[]): Promise<string> {
  return new Promise((resolve, reject) => {
    streamChat(p, messages, { onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)) });
  });
}

// ---------- 选中改写 ----------

export type RewriteAction = 'polish' | 'continue' | 'shorten' | 'translate' | 'tone' | 'custom';

const SYSTEM_REWRITE =
  '你是写作助手。只输出改写后的正文（Markdown），不要解释、不要加引号、不要加前后缀。保持原文的 Markdown 格式（链接、强调、列表、双链 [[...]]）。';

/** 不同语言的界面下，"翻译"的方向：中文 ↔ 英文 */
function translateTarget(text: string): string {
  return /[一-鿿]/.test(text) ? '英文' : '简体中文';
}

export function rewritePrompt(action: RewriteAction, selection: string, context: string, instruction = ''): ChatMessage[] {
  const task: Record<RewriteAction, string> = {
    polish: '润色下面这段文字：通顺、准确、简洁，不改变原意和语气。',
    continue: '接着下面这段文字往下写一段，风格和语气保持一致。只输出续写的部分。',
    shorten: '把下面这段文字缩写到原来的一半左右，保留关键信息。',
    translate: `把下面这段文字翻译成${translateTarget(selection)}。`,
    tone: `把下面这段文字改成${instruction || '更正式'}的语气。`,
    custom: instruction,
  };
  return [
    { role: 'system', content: SYSTEM_REWRITE },
    {
      role: 'user',
      content: `${task[action]}\n\n上下文（只用来理解，不要改写）：\n${context}\n\n要处理的文字：\n${selection}`,
    },
  ];
}

/** 没配模型时的提示（不报错、不弹窗，入口显示"去设置模型"） */
export function needModel(): boolean {
  return !useApp.getState().ai.chat;
}

export function openAiSettings() {
  useApp.setState({ settingsTab: 'ai', aiRewrite: null });
}
