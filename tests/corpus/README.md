English | [简体中文](README-zh.md)

# Fidelity regression corpus

Acceptance check: change one character in WYSIWYG mode and save, and `git diff` shows a change only in that block.

- `agent/`: plans, roadmaps, and architecture docs written by AI agents
- `github/`: GitHub-style READMEs
- `obsidian/`: Obsidian notes (frontmatter, wikilinks, tags, callouts, highlights, math)
- `edge/`: edge cases such as line endings, indentation, and escaping

The test is in `packages/editor-wysiwyg/src/fidelity.test.ts` and runs over every `.md` file in this directory (except `README.md` and `README-zh.md`).
To add a sample, put it in the matching directory. Files are read byte for byte; do not let an editor or formatter change them.
