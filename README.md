English | [简体中文](README-zh.md)

<p align="center"><img src="apps/desktop/src-tauri/icons/icon.svg" width="112" height="112" alt="Zyrite logo"></p>

# Zyrite

An open-source, free Markdown editor: writes like Typora, organizes like a lightweight Obsidian, and is built for reviewing and annotating documents written by AI agents.

> Status: the editor, vault, agent review and MCP, built-in AI, and themes / images / export / shortcuts are done; private beta is next.

## Development

Requirements:

- Node.js 22+, pnpm 11 (`corepack enable`)
- Rust stable
- Platform prerequisites: <https://v2.tauri.app/start/prerequisites/>

```sh
pnpm install
pnpm dev          # run the desktop app (Tauri + Vite hot reload)
pnpm dev:web      # run only the frontend in a browser, no Rust needed
pnpm test         # frontend unit tests
pnpm typecheck
pnpm build        # build installers for the current platform into target/release/bundle/
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

## Layout

```
apps/desktop/            Tauri app: src/ (React frontend) + src-tauri/ (Rust, wiring only)
crates/zyrite-core/      Core library: file I/O (atomic save, external change detection), vault (file tree,
                         watching, file operations), link and tag index, full-text search, recovery cache,
                         .zyrite/ data (baselines, pending reviews, annotations), vector index
crates/zyrite-mcp/       MCP server (stdio, `zyrite mcp --vault <path> [--lang en|zh-CN]`)
crates/zyrite-ai/        Model calls for the built-in AI (OpenAI-compatible APIs, Ollama; streaming, embeddings)
crates/zyrite-export/    Word (.docx) export
crates/zyrite-i18n/      Language for backend messages: English by default, Simplified Chinese optional
packages/md-blocks/      Markdown parsing, top-level block splitting, source positions, style detection
packages/editor-common/  Interfaces, rendering, and typography shared by both editors
packages/editor-live/    Live preview (CodeMirror 6)
packages/editor-wysiwyg/ WYSIWYG (ProseMirror, block-level write-back)
packages/themes/         Tokens for the 3 built-in themes (Frost, Graphite, Signal)
tests/corpus/            Fidelity regression corpus
.github/workflows/       CI and builds for three platforms
```

## License

[Apache-2.0](LICENSE). "Zyrite" and "纸砚" are trademarks of z-y.ai; the license does not grant trademark rights, so forks must use a different name. See [NOTICE](NOTICE).

Made by [z-y.ai](https://z-y.ai)
