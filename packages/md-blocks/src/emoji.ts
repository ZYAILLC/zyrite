import { gemoji } from 'gemoji';

let byName: Map<string, string> | undefined;

/** GitHub 表情短代码名（不含冒号，例如 `rocket`、`+1`）→ 表情字符；不认识返回 undefined */
export function emojiByName(name: string): string | undefined {
  if (!byName) {
    byName = new Map();
    for (const g of gemoji) for (const n of g.names) byName.set(n, g.emoji);
  }
  return byName.get(name);
}
