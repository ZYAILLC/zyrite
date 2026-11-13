---
aliases: [Zyrite MOC, 纸砚索引]
tags:
  - moc
  - project/zyrite
created: 2026-11-01T09:30
---

# Zyrite MOC

%%这是索引笔记，自动生成的部分不要手改%%

## 方案

- [[zyrite-方案]] · [[zyrite-方案#定位|定位]] · [[竞品调研|调研]]
- 设计稿：![[main-board.png|480]]
- 架构由 Agent 维护：[[architecture]] #agent/claude

## 进度 #project/zyrite

- [x] M0 骨架 ✅ 2026-11-07
- [ ] M1 编辑器 📅 2026-11-20
    - [x] 实时预览
    - [ ] 查找替换 ⏫
- [ ] M2 库

> [!warning]- 风险（点开）
> 所见即所得的==原文保真==最难。
> > [!note] 对策
> > 块级回写 + 回归语料，见 [[fidelity]]。

> [!quote] Typora
> 写起来像 Typora，管理起来像 Obsidian。

## 查询

```dataview
TABLE status, due
FROM #project/zyrite
WHERE !completed
SORT due ASC
```

关键结论放在这里。 ^conclusion

引用上面的结论：![[moc#^conclusion]]
