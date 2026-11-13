import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 测试用：读取 tests/corpus 下的全部语料（不含说明文件 README.md） */
export function loadCorpus(): { name: string; source: string }[] {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../../tests/corpus');
  const out: { name: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md') && p !== join(root, 'README.md') && p !== join(root, 'README-zh.md')) {
        out.push({ name: relative(root, p), source: readFileSync(p, 'utf8') });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
