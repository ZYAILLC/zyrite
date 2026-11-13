import { useApp } from '../store';
import type { McpGrant } from './backend';
import { deps } from './document';

/**
 * MCP 接入授权：Agent 第一次访问库时 `zyrite mcp` 放一份请求，这里弹窗问用户；
 * 允许后写一条"读 + 提交写入"的授权，权限和撤销在 设置 › MCP 里。
 */

let seq = 0;

export async function loadAccess(): Promise<void> {
  const n = ++seq;
  const { folder } = useApp.getState();
  if (!folder) {
    useApp.setState({ access: { grants: [], requests: [] } });
    return;
  }
  try {
    const access = await deps.backend.mcpAccessList();
    if (n === seq && useApp.getState().folder === folder) useApp.setState({ access });
  } catch {
    // 读不到就保持原样，下次变化再读
  }
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    useApp.getState().setNotice({ text: String(e instanceof Error ? e.message : e), error: true });
  }
  await loadAccess();
}

export function answerRequest(id: string, allow: boolean): Promise<void> {
  // 先从界面上拿掉，免得连点
  const { access } = useApp.getState();
  useApp.setState({ access: { ...access, requests: access.requests.filter((r) => r.id !== id) } });
  return run(() => deps.backend.mcpAccessAnswer(id, allow));
}

export function setGrant(g: McpGrant, write: boolean, directWrite: boolean): Promise<void> {
  return run(() => deps.backend.mcpGrantSet(g.id, write, directWrite && write));
}

export function revokeGrant(id: string): Promise<void> {
  return run(() => deps.backend.mcpGrantRevoke(id));
}
