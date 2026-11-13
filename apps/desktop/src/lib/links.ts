import type { NoteName } from './backend';

/**
 * 双链解析，规则和 crates/zyrite-core/src/index.rs 一致（那边有同样的测试用例）：
 * - `[[名字]]`：按文件名（不含扩展名，不区分大小写）在整个库里找；重名时优先同一文件夹，其次路径最短
 * - `[[文件夹/名字]]`：按路径找，先相对当前笔记，再相对库根目录
 * - 带非 Markdown 扩展名的（`![[图.png]]`）是附件，不算笔记链接
 * 编辑器渲染时要同步判断链接存不存在，所以在前端用索引给的笔记名单解析，不每次调用后端。
 */

export type LinkStatus = { kind: 'note'; rel: string } | { kind: 'missing' } | { kind: 'other' };

const MD_EXT = /\.(md|markdown|mdown|mkd|mdx)$/i;

const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const withoutExt = (rel: string) => {
  const nameStart = rel.lastIndexOf('/') + 1;
  const dot = rel.lastIndexOf('.');
  return dot > nameStart ? rel.slice(0, dot) : rel;
};

function joinRel(dir: string, rel: string): string | null {
  const parts = rel.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const seg of rel.split(/[/\\]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

export interface Resolver {
  resolveWiki(target: string, fromRel: string): LinkStatus;
}

export function createResolver(names: readonly NoteName[]): Resolver {
  const byStem = new Map<string, string[]>();
  const byPath = new Map<string, string>();
  for (const n of names) {
    const key = n.stem.toLowerCase();
    byStem.set(key, [...(byStem.get(key) ?? []), n.rel]);
    byPath.set(withoutExt(n.rel).toLowerCase(), n.rel);
  }
  return {
    resolveWiki(target, fromRel) {
      let t = target.trim();
      if (!t) return { kind: 'other' };
      const name = t.slice(t.lastIndexOf('/') + 1);
      const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1];
      if (ext && !MD_EXT.test(name)) return { kind: 'other' };
      if (MD_EXT.test(t)) t = withoutExt(t);
      if (t.includes('/')) {
        for (const base of [dirOf(fromRel), '']) {
          const rel = joinRel(base, t);
          const hit = rel !== null ? byPath.get(rel.toLowerCase()) : undefined;
          if (hit) return { kind: 'note', rel: hit };
        }
        return { kind: 'missing' };
      }
      const cands = byStem.get(t.toLowerCase());
      if (!cands?.length) return { kind: 'missing' };
      const here = dirOf(fromRel);
      const best = [...cands].sort(
        (a, b) =>
          Number(dirOf(a) !== here) - Number(dirOf(b) !== here) || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
      )[0]!;
      return { kind: 'note', rel: best };
    },
  };
}
