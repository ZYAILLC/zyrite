---
description: Zyrite 前端代码规范
globs: apps/desktop/src/**/*.tsx, packages/**/*.ts
alwaysApply: false
---

# 前端规范

You are an expert in TypeScript, React 19 and CodeMirror 6.

## 代码风格

- 用函数组件和 hooks；**不要**用 class 组件（CodeMirror 的 `WidgetType` 除外）
- 状态放 Zustand，组件里只订阅需要的切片：`useApp((s) => s.edition)`
- 文案一律从 `i18n` 取，*不要*在组件里写死中文
- CSS 变量用 `--z-*`，不要写死颜色

## 命名

* 组件：`PascalCase.tsx`
* 工具函数：`camelCase.ts`
* 测试：和被测文件同目录，`*.test.ts`

## 禁止

1. 现成组件库的默认样式
2. `any`（确实需要时用 `unknown` 再收窄）
3. 在渲染里调用 `splitBlocks`，必须 `useMemo`

@file docs/plan.md
