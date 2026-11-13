//! 模拟 Claude Code 跑一遍 Agent 协作的验收流程：读批注 → 修改文件 → 回复并改状态

use std::fs;

use serde_json::{json, Value};
use zyrite_core::grants::{self, Grant};
use zyrite_core::store::{Anchor, Annotation, Store, VaultConfig};
use zyrite_mcp::Server;

const KEY: [u8; 32] = [7; 32];

/// 用户已经允许这个测试客户端访问（读、写、直接写都放开，权限由库设置控制）
fn allow(root: &std::path::Path) {
    let mut g = Grant {
        id: "g_test".into(),
        name: "Claude Code".into(),
        exe: "test-client".into(),
        write: true,
        direct_write: true,
        created_ms: 1,
        sig: String::new(),
    };
    grants::sign(&KEY, root, &mut g);
    Store::new(root).save_grants(&[g]).unwrap();
}

fn session(root: &std::path::Path, requests: &[Value]) -> Vec<Value> {
    allow(root);
    let input: String = requests.iter().map(|r| format!("{r}\n")).collect();
    let mut out = Vec::new();
    Server::new(root.to_path_buf())
        .with_access(|| Some(KEY.to_vec()), "test-client", 300)
        .serve(input.as_bytes(), &mut out)
        .unwrap();
    String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn call(id: u64, name: &str, args: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": name, "arguments": args } })
}

fn result(r: &Value) -> &Value {
    assert!(r["result"]["isError"].as_bool() != Some(true), "{r}");
    &r["result"]["structuredContent"]
}

fn init() -> Value {
    json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "claude-code", "version": "2.0" }
    } })
}

#[test]
fn 批注处理流程() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("docs")).unwrap();
    fs::write(
        root.join("docs/architecture.md"),
        "# 架构\n\n对外提供五个工具，写入进队列。\n",
    )
    .unwrap();
    fs::write(root.join("docs/plan.md"), "见 [[architecture]]。#agent\n").unwrap();
    let store = Store::new(root);
    store
        .save_annotations(
            "docs/architecture.md",
            &[Annotation {
                id: "an_1".into(),
                file: "docs/architecture.md".into(),
                anchor: Anchor {
                    text: "五个工具".into(),
                    prefix: "对外提供".into(),
                    suffix: "，写入".into(),
                },
                body: "再加一个 reply_annotation".into(),
                assignee: "any".into(),
                status: "open".into(),
                thread: vec![],
                created_at: "1".into(),
            }],
        )
        .unwrap();

    let r = session(
        root,
        &[
            init(),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
            call(2, "get_annotations", json!({ "status": "open" })),
            call(
                3,
                "write_note",
                json!({ "path": "docs/architecture.md", "mode": "patch", "reason": "处理批注",
                "patch": [{ "old": "五个工具", "new": "六个工具（新增 reply_annotation）" }] }),
            ),
            call(4, "read_note", json!({ "path": "docs/architecture.md" })),
            call(
                5,
                "reply_annotation",
                json!({ "id": "an_1", "message": "已加上，见审阅队列", "status": "changed" }),
            ),
            call(6, "search_notes", json!({ "query": "架构" })),
            call(
                7,
                "list_backlinks",
                json!({ "path": "docs/architecture.md" }),
            ),
            call(8, "list_notes", json!({ "folder": "docs" })),
        ],
    );
    // 通知没有回复
    assert_eq!(r.len(), 9);
    assert_eq!(r[0]["result"]["serverInfo"]["name"], "zyrite");
    assert_eq!(r[0]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(r[1]["result"]["tools"].as_array().unwrap().len(), 7);

    let anns = &result(&r[2])["annotations"];
    assert_eq!(anns[0]["quote"], "五个工具");
    assert_eq!(anns[0]["line"], 3);

    assert_eq!(result(&r[3])["queued"], true);
    // 文件本身没改，改动在队列里
    assert_eq!(
        fs::read_to_string(root.join("docs/architecture.md")).unwrap(),
        "# 架构\n\n对外提供五个工具，写入进队列。\n"
    );
    let q = store.queued("docs/architecture.md").unwrap();
    assert_eq!(q.agent, "Claude Code");
    assert!(q.content.contains("六个工具（新增 reply_annotation）"));
    assert!(result(&r[4])["pendingReview"]
        .as_str()
        .unwrap()
        .contains("六个工具"));

    assert_eq!(result(&r[5])["status"], "changed");
    let a = &store.annotations("docs/architecture.md")[0];
    assert_eq!(
        (a.status.as_str(), a.thread[0].by.as_str()),
        ("changed", "Claude Code")
    );

    assert_eq!(result(&r[6])["results"][0]["path"], "docs/architecture.md");
    assert_eq!(result(&r[7])["backlinks"][0]["path"], "docs/plan.md");
    assert_eq!(result(&r[8])["notes"].as_array().unwrap().len(), 2);

    // 活动记录、断开后不再算已连接
    let acts = store.activity(20);
    assert!(acts
        .iter()
        .any(|a| a.action == "write" && a.added == 1 && a.removed == 1));
    assert!(store.agents().is_empty());
}

#[test]
fn 出错和权限() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("a.md"), "x x\n").unwrap();
    let r = session(
        root,
        &[
            init(),
            call(1, "read_note", json!({ "path": "../etc/passwd.md" })),
            call(2, "read_note", json!({ "path": "/abs.md" })),
            call(
                3,
                "write_note",
                json!({ "path": "a.md", "mode": "patch", "patch": [{ "old": "x", "new": "y" }] }),
            ),
            call(
                4,
                "write_note",
                json!({ "path": "new/note.md", "mode": "replace", "content": "# 新笔记\n" }),
            ),
            call(5, "nope", json!({})),
            json!({ "jsonrpc": "2.0", "id": 6, "method": "nope" }),
        ],
    );
    for i in [1, 2, 3, 5] {
        assert_eq!(r[i]["result"]["isError"], true, "{}", r[i]);
    }
    assert!(r[3]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("appears 2 times"));
    assert_eq!(result(&r[4])["queued"], true);
    assert_eq!(r[6]["error"]["code"], -32601);

    // 关闭写入；开启直接写入
    let store = Store::new(root);
    let mut c = VaultConfig::default();
    c.mcp.write = false;
    store.set_config(&c).unwrap();
    let r = session(
        root,
        &[
            init(),
            call(
                1,
                "write_note",
                json!({ "path": "a.md", "mode": "append", "content": "y" }),
            ),
        ],
    );
    assert_eq!(r[1]["result"]["isError"], true);
    c.mcp.write = true;
    c.mcp.direct_write = true;
    store.set_config(&c).unwrap();
    let r = session(
        root,
        &[
            init(),
            call(
                1,
                "write_note",
                json!({ "path": "a.md", "mode": "append", "content": "y" }),
            ),
        ],
    );
    assert_eq!(result(&r[1])["written"], true);
    assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "x x\ny");
    assert_eq!(store.baseline("a.md").as_deref(), Some("x x\ny"));
}
