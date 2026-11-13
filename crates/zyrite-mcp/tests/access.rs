//! MCP 接入授权：没授权的程序要等用户在 Zyrite 里点"允许"，篡改授权记录无效

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use zyrite_core::grants::{self, Grant};
use zyrite_core::store::{self, Store};
use zyrite_mcp::Server;

const KEY: [u8; 32] = [9; 32];
const EXE: &str = "/usr/local/bin/agent";

fn requests(name: &str) -> String {
    let init = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "claude-code", "version": "2" }
    } });
    let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments":
        if name == "write_note" { json!({ "path": "a.md", "mode": "append", "content": "y" }) } else { json!({ "path": "a.md" }) } } });
    format!("{init}\n{call}\n")
}

/// 跑一次调用，返回工具结果；wait_ms 是等用户点的时长
fn run(root: &Path, tool: &str, wait_ms: u64) -> Value {
    let mut out = Vec::new();
    Server::new(root.to_path_buf())
        .with_access(|| Some(KEY.to_vec()), EXE, wait_ms)
        .serve(requests(tool).as_bytes(), &mut out)
        .unwrap();
    let last = String::from_utf8(out)
        .unwrap()
        .lines()
        .last()
        .unwrap()
        .to_string();
    serde_json::from_str::<Value>(&last).unwrap()["result"].clone()
}

fn text(r: &Value) -> String {
    r["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn grant(write: bool) -> Grant {
    Grant {
        id: store::new_id("g"),
        name: "Claude Code".into(),
        exe: EXE.into(),
        write,
        direct_write: false,
        created_ms: store::now_ms(),
        sig: String::new(),
    }
}

fn vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.md"), "x\n").unwrap();
    dir
}

/// 模拟应用：开着这个库，看到请求后按 allow 处理
fn app(root: &Path, allow: Option<bool>) -> thread::JoinHandle<()> {
    let root = root.to_path_buf();
    let s = Store::new(&root);
    s.app_heartbeat(1).unwrap();
    thread::spawn(move || {
        for _ in 0..50 {
            thread::sleep(Duration::from_millis(50));
            let Some(r) = s.requests().into_iter().next() else {
                continue;
            };
            assert_eq!((r.name.as_str(), r.exe.as_str()), ("Claude Code", EXE));
            match allow {
                Some(true) => {
                    let mut g = grant(true);
                    grants::sign(&KEY, &root, &mut g);
                    s.save_grants(&[g]).unwrap();
                }
                Some(false) => s
                    .put_request(&grants::AccessRequest { denied: true, ..r })
                    .unwrap(),
                None => {}
            }
            return;
        }
    })
}

#[test]
fn 应用没开_没授权直接拒绝() {
    let dir = vault();
    let r = run(dir.path(), "read_note", 5_000);
    assert_eq!(r["isError"], true);
    assert!(text(&r).contains("open Zyrite"), "{r}");
    assert!(Store::new(dir.path()).requests().is_empty());
}

#[test]
fn 用户允许后继续() {
    let dir = vault();
    let t = app(dir.path(), Some(true));
    let r = run(dir.path(), "read_note", 5_000);
    t.join().unwrap();
    assert_ne!(r["isError"], true, "{r}");
    assert_eq!(r["structuredContent"]["content"], "x\n");
    assert!(
        Store::new(dir.path()).requests().is_empty(),
        "请求处理完要删掉"
    );
    // 之后再连：已有授权，不再询问（应用没开也行）
    fs::remove_file(dir.path().join(".zyrite/app.json")).unwrap();
    assert_ne!(run(dir.path(), "read_note", 5_000)["isError"], true);
}

#[test]
fn 用户拒绝() {
    let dir = vault();
    let t = app(dir.path(), Some(false));
    let r = run(dir.path(), "read_note", 5_000);
    t.join().unwrap();
    assert!(text(&r).contains("denied"), "{r}");
    assert!(Store::new(dir.path()).request("x").is_none());
    assert!(fs::read_dir(dir.path().join(".zyrite/requests"))
        .unwrap()
        .next()
        .is_none());
}

#[test]
fn 等待超时() {
    let dir = vault();
    let t = app(dir.path(), None);
    let r = run(dir.path(), "read_note", 400);
    t.join().unwrap();
    assert!(text(&r).contains("Timed out"), "{r}");
    assert!(fs::read_dir(dir.path().join(".zyrite/requests"))
        .unwrap()
        .next()
        .is_none());
}

#[test]
fn 篡改授权记录无效() {
    let dir = vault();
    let s = Store::new(dir.path());
    let mut g = grant(false);
    grants::sign(&KEY, dir.path(), &mut g);
    // Agent 自己把写入权限打开
    g.write = true;
    s.save_grants(&[g]).unwrap();
    let r = run(dir.path(), "read_note", 5_000);
    assert!(text(&r).contains("hasn't allowed"), "{r}");
}

#[test]
fn 只读授权不能写() {
    let dir = vault();
    let s = Store::new(dir.path());
    let mut g = grant(false);
    grants::sign(&KEY, dir.path(), &mut g);
    s.save_grants(&[g]).unwrap();
    assert_ne!(run(dir.path(), "read_note", 5_000)["isError"], true);
    let r = run(dir.path(), "write_note", 5_000);
    assert!(text(&r).contains("write access"), "{r}");
    assert!(s.queued("a.md").is_none());
}

/// 数一下读了几次密钥（真实环境里每次读钥匙串都可能弹系统对话框）
fn count_key_reads(root: &Path, tools: &[&str], wait_ms: u64) -> usize {
    let reads = Arc::new(AtomicUsize::new(0));
    let counter = reads.clone();
    let mut input = requests(tools[0]);
    for t in &tools[1..] {
        input.push_str(requests(t).lines().last().unwrap());
        input.push('\n');
    }
    let mut out = Vec::new();
    Server::new(root.to_path_buf())
        .with_access(
            move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Some(KEY.to_vec())
            },
            EXE,
            wait_ms,
        )
        .serve(input.as_bytes(), &mut out)
        .unwrap();
    reads.load(Ordering::SeqCst)
}

#[test]
fn 没有这个程序的授权时不读钥匙串() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.md"), "x").unwrap();
    assert_eq!(count_key_reads(dir.path(), &["read_note"], 0), 0);
    // 应用开着、等用户回答的这段时间也不读
    Store::new(dir.path()).app_heartbeat(1).unwrap();
    assert_eq!(count_key_reads(dir.path(), &["read_note"], 500), 0);
}

#[test]
fn 一个进程只读一次钥匙串() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.md"), "x").unwrap();
    let store = Store::new(dir.path());
    let mut g = grant(true);
    grants::sign(&KEY, dir.path(), &mut g);
    store.save_grants(&[g]).unwrap();
    assert_eq!(
        count_key_reads(dir.path(), &["read_note", "read_note", "read_note"], 0),
        1
    );
}
