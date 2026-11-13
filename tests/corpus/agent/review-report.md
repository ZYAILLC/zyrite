# Code Review: PR #128 「块级回写支持表格」

**结论：需要修改后合并**　|　审阅者：Claude　|　2026-11-06

## 摘要

整体思路正确[^1]，但有两个阻断问题和若干建议。

<details>
<summary>变更文件（7 个）</summary>

- `packages/md-blocks/src/stringify.ts` (+142 −38)
- `packages/editor-wysiwyg/src/to-mdast.ts` (+56 −12)
- `tests/corpus/edge/tables.md` (新增)

</details>

## 问题

### 🔴 阻断

1. **对齐行被重写**：原文 `|:--|` 保存后变成 `| :-- |`。

   > 复现：打开 `tests/corpus/edge/syntax-mix.md`，在表格里改一个字。
   >
   > - 期望：只有那一行变化
   > - 实际：分隔行也变了

2. **转义竖线丢失**：`a \| b` 变成 `a | b`，表格列数错乱。

### 🟡 建议

- `stringifyTable` 有 80 行，建议拆出 `padCell()`
- 变量名 `t` 太短，改成 `table`

### 🟢 做得好的地方

- 回归语料覆盖了无外侧竖线的写法 👍

## 结论

| 项 | 状态 |
|:---|:---:|
| 测试 | ✅ 通过 |
| 保真语料 | ❌ 2 篇失败 |
| 类型检查 | ✅ |

[^1]: 见 docs/plan.md 4.1「只重写被编辑过的块」。
