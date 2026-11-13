[English](README.md) | 简体中文

# 保真回归语料

验收标准：在所见即所得下改一个字再保存，`git diff` 只出现那一块的变化。

- `agent/`：AI Agent 写的方案、计划、架构文档
- `github/`：GitHub 风格的 README
- `obsidian/`：Obsidian 笔记（frontmatter、双链、标签、callout、高亮、公式）
- `edge/`：换行符、缩进、转义等边界情况

测试在 `packages/editor-wysiwyg/src/fidelity.test.ts`，会遍历本目录下所有 `.md` 文件（`README.md` 和 `README-zh.md` 除外）。
新增语料直接放进对应目录即可；文件按原样读取，不要让编辑器或格式化工具改动它们。
