[English](README.md) | 简体中文

<p align="center"><img src="apps/desktop/src-tauri/icons/icon.svg" width="112" height="112" alt="Zyrite logo"></p>

# Zyrite（纸砚）

开源、免费的 Markdown 编辑器：写起来像 Typora，管理起来像轻量版 Obsidian，并且专门为 AI Agent 写出来的文档做了阅读、审阅和批注。

> 状态：编辑器、库、Agent 协作与 MCP、内置 AI、主题 / 图片 / 导出 / 快捷键都已完成，下一步 Beta 内测。

## 开发

需要：

- Node.js 22+，pnpm 11（`corepack enable`）
- Rust stable
- 系统依赖：<https://v2.tauri.app/start/prerequisites/>

```sh
pnpm install
pnpm dev          # 启动桌面应用（Tauri + Vite 热更新）
pnpm dev:web      # 只在浏览器里跑前端，不需要 Rust
pnpm test         # 前端单元测试
pnpm typecheck
pnpm build        # 打本机平台的安装包，输出在 target/release/bundle/
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

## 目录

```
apps/desktop/            Tauri 应用：src/（React 前端）+ src-tauri/（Rust，只做组装）
crates/zyrite-core/      核心库：文件读写（原子保存、外部修改检测）、库（文件树、监听、文件操作）、
                         链接和标签索引、全文搜索、恢复缓存、.zyrite/ 数据（基线、待审阅、批注）、向量索引
crates/zyrite-mcp/       MCP server（stdio，`zyrite mcp --vault <路径> [--lang en|zh-CN]`）
crates/zyrite-ai/        内置 AI 的模型调用（OpenAI 兼容接口、Ollama；流式输出、向量）
crates/zyrite-export/    Word（.docx）导出
crates/zyrite-i18n/      后端文案的语言：默认英文，可选简体中文
packages/md-blocks/      Markdown 解析、顶层块切分、源码位置、风格探测
packages/editor-common/  两种编辑器共用的接口、渲染、正文排版
packages/editor-live/    实时预览（CodeMirror 6）
packages/editor-wysiwyg/ 所见即所得（ProseMirror，块级回写）
packages/themes/         3 套内置主题的 token（冷白、石墨、信号）
tests/corpus/            保真回归语料
.github/workflows/       CI 和三平台打包
```

## 许可证

[Apache-2.0](LICENSE)。"Zyrite" 和 "纸砚" 是 z-y.ai 的商标，许可证不授予商标权，fork 后请换名发布，见 [NOTICE](NOTICE)。

Made by [z-y.ai](https://z-y.ai)
