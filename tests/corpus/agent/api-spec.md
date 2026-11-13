# Zyrite MCP 接口

> 版本 0.1 · 传输：stdio · 协议：[MCP 2025-06-18](https://modelcontextprotocol.io/specification)

## 工具一览

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `list_notes` | `folder?: string` | `{ path, title, mtime }[]` |
| `search_notes` | `query: string`<br>`limit?: number` | `{ path, snippet, score }[]` |
| `write_note` | `path`, `content`, `mode: "replace" \| "append"` | `{ queued: boolean }` |

## `write_note`

请求：

```json
{
  "path": "docs/architecture.md",
  "content": "# 架构\n\n...",
  "mode": "replace"
}
```

响应：

```json
{ "queued": true, "reviewId": "rv_01JC3Z" }
```

错误码：

Code | 含义
---- | ----
`E_NOT_IN_VAULT` | 路径不在库内
`E_CONFLICT` | 用户有未保存修改且重叠

## HTTP 调试（应用运行时）

```http
POST http://127.0.0.1:47321/mcp HTTP/1.1
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

    # 缩进式代码块：旧文档里常见
    curl -s localhost:47321/health
