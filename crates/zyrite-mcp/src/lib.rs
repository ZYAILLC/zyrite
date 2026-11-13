//! Zyrite 的 MCP server：`zyrite mcp --vault <库>`，stdio 传输（每行一条 JSON-RPC 消息）。
//!
//! 直接读写库和 `.zyrite/`：写入进审阅队列（`.zyrite/queue/`），批注回复写进 `.zyrite/annotations/`，
//! 读写记录追加到 `.zyrite/activity.jsonl`。应用开着时通过文件监听实时看到；没开时下次打开再审阅。
//!
//! 协议实现只用到 MCP 的 initialize、tools/list、tools/call、ping，没有引入 SDK。

use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};
use zyrite_core::grants::{self, AccessRequest, Grant};
use zyrite_core::index::Index;
use zyrite_core::links::is_markdown_path;
use zyrite_core::store::{self, locate, Activity, AgentInfo, QueueItem, Store, ThreadEntry};
use zyrite_core::vault;
use zyrite_i18n::{tr, trf};

/// 支持的协议版本，按新到旧
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS_EN: &str = "Zyrite is a Markdown editor; this server lets you read and write the user's notes vault. \
Writes (write_note) don't change files directly: they go into the user's review queue, and the user accepts or rejects each change in Zyrite. \
The user can leave annotations for you in notes: read them with get_annotations; after changing the file, reply with reply_annotation and set the status to changed. \
All paths are relative to the vault root, e.g. docs/plan.md. \
The first time you call a tool, the user has to allow you to access this vault in Zyrite (you wait up to 60 seconds); if access is denied or times out, tell the user instead of retrying again and again.";

const INSTRUCTIONS_ZH: &str = "Zyrite 是一个 Markdown 编辑器，这个 server 让你读写用户的笔记库。\
写入（write_note）不会直接改文件，而是进入用户的审阅队列，用户在 Zyrite 里逐处接受或拒绝。\
用户可以在笔记里给你留批注：用 get_annotations 读取，修改文件后用 reply_annotation 回复并把状态改成 changed。\
路径都是相对库根目录的路径，例如 docs/plan.md。\
第一次调用工具时，用户需要在 Zyrite 里允许你访问这个库（最多等 60 秒）；被拒绝或超时请告诉用户，不要反复重试。";

/// 授权签名密钥从哪里来：正常是系统钥匙串，测试里直接给
type KeySource = Box<dyn Fn() -> Option<Vec<u8>> + Send>;

pub struct Server {
    root: PathBuf,
    store: Store,
    agent: String,
    started_ms: u64,
    index: Option<Index>,
    /// 建索引时各文件的修改时间，用来增量刷新
    mtimes: HashMap<String, u64>,
    /// 启动这个 MCP server 的程序（授权按它和 agent 名字一起记）
    client_exe: String,
    key: KeySource,
    /// 读过的密钥。读钥匙串可能弹系统对话框并卡住，一个进程只读一次
    key_read: Option<Option<Vec<u8>>>,
    /// 等用户在 Zyrite 里点"允许 / 拒绝"最多多久
    wait_ms: u64,
}

/// 钥匙串里的授权签名密钥；Zyrite 第一次授权时创建，这里只读
fn keychain_key() -> Option<Vec<u8>> {
    let entry = keyring::Entry::new(grants::KEY_SERVICE, grants::KEY_ACCOUNT).ok()?;
    grants::decode_key(&entry.get_password().ok()?)
}

/// 某个进程的可执行文件路径。macOS 上 `ps -o comm=` 只给启动时写的名字（比如 `claude`），要问内核才有完整路径
#[cfg(unix)]
fn exe_of(pid: u32) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let mut buf = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: 缓冲区在这次调用期间有效，长度如实传入；内核只写入返回值那么多字节
        let n = unsafe {
            libc::proc_pidpath(
                pid as libc::c_int,
                buf.as_mut_ptr().cast(),
                buf.len() as u32,
            )
        };
        if n > 0 {
            return Some(String::from_utf8_lossy(&buf[..n as usize]).into_owned());
        }
    }
    if let Ok(p) = fs::read_link(format!("/proc/{pid}/exe")) {
        return Some(p.display().to_string());
    }
    let out = std::process::Command::new("ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

#[cfg(unix)]
fn parent_of(pid: u32) -> Option<u32> {
    if let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) {
        // pid (comm) state ppid ...；comm 里可能有空格，从最后一个 ')' 往后数
        return stat
            .rsplit_once(')')?
            .1
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok();
    }
    let out = std::process::Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// 启动 `zyrite mcp` 的程序：父进程；如果是 shell、env、npx 之类的中转，再往上找
fn client_exe() -> String {
    #[cfg(unix)]
    {
        const RELAYS: &[&str] = &[
            "sh", "bash", "zsh", "dash", "fish", "env", "npx", "uvx", "timeout",
        ];
        let mut pid = std::os::unix::process::parent_id();
        for _ in 0..4 {
            let Some(exe) = exe_of(pid) else { break };
            let base = exe
                .rsplit('/')
                .next()
                .unwrap_or(&exe)
                .trim_start_matches('-');
            match parent_of(pid) {
                Some(up) if RELAYS.contains(&base) && up > 1 => pid = up,
                _ => return exe,
            }
        }
        String::new()
    }
    #[cfg(not(unix))]
    {
        String::new()
    }
}

/// 把客户端名字换成界面上显示的名字
pub fn display_name(client: &str) -> String {
    let c = client.to_lowercase();
    if c.contains("claude") {
        "Claude Code".into()
    } else if c.contains("cursor") {
        "Cursor".into()
    } else if c.contains("codex") {
        "Codex".into()
    } else if client.trim().is_empty() {
        tr("MCP client", "MCP 客户端").into()
    } else {
        client.to_string()
    }
}

fn mtime_ms(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

fn tool_error(msg: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": msg.into() }], "isError": true })
}

fn tool_ok(value: Value) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_default();
    json!({ "content": [{ "type": "text", "text": text }], "structuredContent": value })
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn line_counts(old: &str, new: &str) -> (usize, usize) {
    // 粗略的 +行 −行：按行多重集合比较
    let mut count: HashMap<&str, i64> = HashMap::new();
    for l in old.lines() {
        *count.entry(l).or_default() -= 1;
    }
    for l in new.lines() {
        *count.entry(l).or_default() += 1;
    }
    let added = count
        .values()
        .filter(|&&v| v > 0)
        .map(|&v| v as usize)
        .sum();
    let removed = count
        .values()
        .filter(|&&v| v < 0)
        .map(|&v| (-v) as usize)
        .sum();
    (added, removed)
}

impl Server {
    pub fn new(root: PathBuf) -> Self {
        Self {
            store: Store::new(&root),
            root,
            agent: display_name(""),
            started_ms: store::now_ms(),
            index: None,
            mtimes: HashMap::new(),
            client_exe: client_exe(),
            key: Box::new(keychain_key),
            key_read: None,
            wait_ms: grants::WAIT_MS,
        }
    }

    /// 测试用：指定签名密钥、客户端程序路径、等待时长
    pub fn with_access(
        mut self,
        key: impl Fn() -> Option<Vec<u8>> + Send + 'static,
        exe: &str,
        wait_ms: u64,
    ) -> Self {
        self.key = Box::new(key);
        self.client_exe = exe.to_string();
        self.wait_ms = wait_ms;
        self
    }

    fn valid_grant(&mut self) -> Option<Grant> {
        let list = self.store.grants();
        // 没有这个程序的授权就不用验签，也就不碰钥匙串（等用户回答时这里每 200 毫秒跑一次）
        if !list
            .iter()
            .any(|g| g.name == self.agent && grants::same_program(&g.exe, &self.client_exe))
        {
            return None;
        }
        let key = self.key_read.get_or_insert_with(|| (self.key)());
        grants::find(
            &list,
            key.as_deref(),
            &self.root,
            &self.agent,
            &self.client_exe,
        )
        .cloned()
    }

    /// 这个程序能不能访问这个库：有有效授权直接放行；没有就请用户在 Zyrite 里决定
    fn authorize(&mut self) -> Result<Grant, String> {
        if let Some(g) = self.valid_grant() {
            return Ok(g);
        }
        let who = if self.client_exe.is_empty() {
            self.agent.clone()
        } else {
            trf!("{} ({})", "{}（{}）", self.agent, self.client_exe)
        };
        if !self.store.app_alive() {
            return Err(trf!(
                "The user hasn't allowed {who} to access this vault yet. Ask the user to open Zyrite and this vault, then try again: Zyrite will ask whether to allow access.",
                "用户还没有允许 {who} 访问这个笔记库。请让用户打开 Zyrite 并打开这个库，然后重试：Zyrite 会询问是否允许。"
            ));
        }
        let request = AccessRequest {
            id: store::new_id("r"),
            name: self.agent.clone(),
            exe: self.client_exe.clone(),
            pid: std::process::id(),
            created_ms: store::now_ms(),
            denied: false,
        };
        self.store
            .put_request(&request)
            .map_err(|e| e.to_string())?;
        let deadline = store::now_ms() + self.wait_ms;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            if let Some(g) = self.valid_grant() {
                self.store.remove_request(&request.id);
                return Ok(g);
            }
            if self.store.request(&request.id).is_some_and(|r| r.denied) {
                self.store.remove_request(&request.id);
                return Err(trf!(
                    "The user denied {who} access to this vault in Zyrite.",
                    "用户在 Zyrite 里拒绝了 {who} 访问这个笔记库。"
                ));
            }
            if store::now_ms() >= deadline {
                self.store.remove_request(&request.id);
                return Err(trf!(
                    "Timed out after {} seconds waiting for the user to allow {who} in Zyrite. Remind the user to watch for the Zyrite prompt, then try again.",
                    "等待用户在 Zyrite 里允许 {who} 访问超时（{} 秒）。请提醒用户留意 Zyrite 的弹窗后重试。",
                    self.wait_ms / 1000
                ));
            }
        }
    }

    /// 只允许库里的 Markdown 文件，路径相对库根目录，不能用 `..` 跑出去（只访问当前库）
    fn resolve(&self, path: &str) -> Result<(String, PathBuf), String> {
        let p = Path::new(path.trim().trim_start_matches("./"));
        if p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
            return Err(trf!(
                "The path must be relative to the vault: {path}",
                "路径必须是库内的相对路径：{path}"
            ));
        }
        let rel = p
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if rel.split('/').any(|s| s.starts_with('.')) {
            return Err(trf!(
                "Hidden folders can't be accessed: {path}",
                "不能访问隐藏目录：{path}"
            ));
        }
        if !is_markdown_path(&rel) {
            return Err(trf!(
                "Only Markdown files can be read or written: {path}",
                "只能读写 Markdown 文件：{path}"
            ));
        }
        Ok((rel.clone(), self.root.join(rel)))
    }

    fn heartbeat(&self) {
        let _ = self.store.heartbeat(&AgentInfo {
            pid: std::process::id(),
            name: self.agent.clone(),
            started_ms: self.started_ms,
            last_seen_ms: store::now_ms(),
        });
    }

    fn log(
        &self,
        action: &str,
        path: Option<&str>,
        detail: Option<String>,
        added: usize,
        removed: usize,
    ) {
        let _ = self.store.log(&Activity {
            at_ms: store::now_ms(),
            agent: self.agent.clone(),
            action: action.into(),
            path: path.map(str::to_string),
            detail,
            added,
            removed,
        });
    }

    /// 索引按需建立，之后只重新读入修改过的文件
    fn index(&mut self) -> io::Result<&Index> {
        let files = vault::list_markdown(&self.root, vault::DEFAULT_LIMIT)?;
        let now: HashMap<String, u64> = files
            .iter()
            .map(|r| (r.clone(), mtime_ms(&self.root.join(r))))
            .collect();
        match &mut self.index {
            None => {
                self.index = Some(Index::build(&self.root)?);
            }
            Some(ix) => {
                for (rel, m) in &now {
                    if self.mtimes.get(rel) != Some(m) {
                        ix.refresh(&self.root.join(rel));
                    }
                }
                for rel in self.mtimes.keys() {
                    if !now.contains_key(rel) {
                        ix.remove(rel);
                    }
                }
            }
        }
        self.mtimes = now;
        Ok(self.index.as_ref().unwrap())
    }

    /// 当前提议的内容：有待审阅的就基于它继续改，否则基于磁盘上的
    fn current(&self, rel: &str, abs: &Path) -> Option<String> {
        self.store
            .queued(rel)
            .map(|q| q.content)
            .or_else(|| fs::read_to_string(abs).ok())
    }

    pub fn tools() -> Value {
        json!([
            {
                "name": "list_notes",
                "description": tr("List the notes in the vault: path, title, modified time.", "列出库里的笔记：路径、标题、修改时间。"),
                "inputSchema": { "type": "object", "properties": {
                    "folder": { "type": "string", "description": tr("Only list this folder (relative path)", "只列这个文件夹（相对路径）") }
                } }
            },
            {
                "name": "search_notes",
                "description": tr(
                    "Full-text search. All space-separated words must appear; \"phrase\"; -exclude; path:folder; #tag. Returns paths, snippets and hit counts.",
                    "全文搜索。空格分隔的词都要出现；\"短语\"；-排除；path:文件夹；#标签。返回路径、片段和命中数。"
                ),
                "inputSchema": { "type": "object", "required": ["query"], "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
                    "tag": { "type": "string", "description": tr("Only search notes with this tag", "只搜带这个标签的笔记") }
                } }
            },
            {
                "name": "read_note",
                "description": tr(
                    "Read a note's source and frontmatter. Changes you submitted that the user hasn't reviewed yet are returned too.",
                    "读取一篇笔记的原文和 frontmatter。如果有你提交、用户还没审阅的修改，会一并返回。"
                ),
                "inputSchema": { "type": "object", "required": ["path"], "properties": {
                    "path": { "type": "string" }
                } }
            },
            {
                "name": "write_note",
                "description": tr(
                    "Write a note. Files aren't changed directly: the change goes into the user's review queue (unless the user turned on direct writes). mode=replace replaces the whole text with content; append adds content at the end; patch applies each old→new in patch (old must appear exactly once in the current text). Use replace to create a note.",
                    "写入笔记。不会直接改文件，而是进入用户的审阅队列（除非用户开启了直接写入）。mode=replace 用 content 替换全文；append 在末尾追加 content；patch 用 patch 里的 old→new 逐个替换（old 必须在当前内容里唯一出现）。新建笔记用 replace。"
                ),
                "inputSchema": { "type": "object", "required": ["path", "mode"], "properties": {
                    "path": { "type": "string" },
                    "mode": { "type": "string", "enum": ["replace", "append", "patch"] },
                    "content": { "type": "string" },
                    "patch": { "type": "array", "items": { "type": "object", "required": ["old", "new"], "properties": {
                        "old": { "type": "string" }, "new": { "type": "string" }
                    } } },
                    "reason": { "type": "string", "description": tr("Why you're making this change; the user sees it while reviewing", "这次修改的目的，用户审阅时看得到") }
                } }
            },
            {
                "name": "list_backlinks",
                "description": tr("Links pointing to this note, with context.", "指向这篇笔记的链接，带上下文。"),
                "inputSchema": { "type": "object", "required": ["path"], "properties": {
                    "path": { "type": "string" }
                } }
            },
            {
                "name": "get_annotations",
                "description": tr(
                    "Read the annotations the user left for agents in Zyrite. status: open (to do), changed (the agent made changes), resolved (done), orphaned (the annotated text can no longer be found).",
                    "读取用户在 Zyrite 里留给 Agent 的批注。status: open（待处理）、changed（Agent 已修改）、resolved（已解决）、orphaned（原文已找不到批注的位置）。"
                ),
                "inputSchema": { "type": "object", "properties": {
                    "path": { "type": "string" },
                    "status": { "type": "string", "enum": ["open", "changed", "resolved", "orphaned"] }
                } }
            },
            {
                "name": "reply_annotation",
                "description": tr(
                    "Reply to an annotation, optionally changing its status. After handling an annotation, usually set it to changed; the user marks it resolved after checking.",
                    "回复批注，可同时改状态。处理完批注后一般把状态改成 changed，由用户确认后标记 resolved。"
                ),
                "inputSchema": { "type": "object", "required": ["id", "message"], "properties": {
                    "id": { "type": "string" },
                    "message": { "type": "string" },
                    "status": { "type": "string", "enum": ["open", "changed", "resolved"] }
                } }
            }
        ])
    }

    pub fn call_tool(&mut self, name: &str, args: &Value) -> Value {
        // 每次调用都重新确认授权：用户在设置里撤销或改了权限，下一次调用就生效
        let grant = match self.authorize() {
            Ok(g) => g,
            Err(e) => return tool_error(e),
        };
        let mut config = self.store.config().mcp;
        config.write &= grant.write;
        config.direct_write &= grant.direct_write;
        let read_tools = [
            "list_notes",
            "search_notes",
            "read_note",
            "list_backlinks",
            "get_annotations",
        ];
        if read_tools.contains(&name) && !config.read {
            return tool_error(tr(
                "The user turned off read access in Zyrite settings",
                "用户在 Zyrite 设置里关闭了读取权限",
            ));
        }
        let result = match name {
            "list_notes" => self.list_notes(args),
            "search_notes" => self.search_notes(args),
            "read_note" => self.read_note(args),
            "write_note" => {
                if !config.write {
                    return tool_error(tr(
                        "The user hasn't given you write access (it can be turned on in Zyrite under Settings › MCP)",
                        "用户没有给你写入权限（在 Zyrite 的 设置 › MCP 里可以打开）"
                    ));
                }
                self.write_note(args, config.direct_write)
            }
            "list_backlinks" => self.list_backlinks(args),
            "get_annotations" => self.get_annotations(args),
            "reply_annotation" => {
                if !config.write {
                    return tool_error(tr(
                        "The user hasn't given you write access (it can be turned on in Zyrite under Settings › MCP)",
                        "用户没有给你写入权限（在 Zyrite 的 设置 › MCP 里可以打开）"
                    ));
                }
                self.reply_annotation(args)
            }
            _ => Err(trf!("No such tool: {name}", "没有这个工具：{name}")),
        };
        match result {
            Ok(v) => tool_ok(v),
            Err(e) => tool_error(e),
        }
    }

    fn list_notes(&mut self, args: &Value) -> Result<Value, String> {
        let folder = arg_str(args, "folder")
            .map(|f| f.trim_matches('/').to_string())
            .filter(|f| !f.is_empty());
        let root = self.root.clone();
        let ix = self.index().map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for n in ix.names() {
            if let Some(f) = &folder {
                if !n.rel.starts_with(&format!("{f}/")) {
                    continue;
                }
            }
            out.push(json!({
                "path": n.rel,
                "title": n.title.clone().unwrap_or_else(|| n.stem.clone()),
                "modifiedMs": mtime_ms(&root.join(&n.rel)),
            }));
        }
        self.log("list", folder.as_deref(), None, 0, 0);
        Ok(json!({ "notes": out }))
    }

    fn search_notes(&mut self, args: &Value) -> Result<Value, String> {
        let mut query = arg_str(args, "query")
            .ok_or(tr("Missing query", "缺少 query"))?
            .to_string();
        if let Some(tag) = arg_str(args, "tag") {
            query.push_str(&format!(" #{}", tag.trim_start_matches('#')));
        }
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(20)
            .clamp(1, 100) as usize;
        let ix = self.index().map_err(|e| e.to_string())?;
        let r = ix.search(&query, limit);
        let hits: Vec<Value> = r
            .hits
            .iter()
            .map(|h| {
                json!({
                    "path": h.rel,
                    "title": h.title,
                    "score": h.count,
                    "snippets": h.matches.iter().map(|m| json!({
                        "line": m.line + 1,
                        "text": format!("{}{}{}", m.before, m.text, m.after),
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        self.log("search", None, Some(query), 0, 0);
        Ok(json!({ "results": hits, "totalNotes": r.total_notes }))
    }

    fn read_note(&mut self, args: &Value) -> Result<Value, String> {
        let (rel, abs) =
            self.resolve(arg_str(args, "path").ok_or(tr("Missing path", "缺少 path"))?)?;
        let content = fs::read_to_string(&abs)
            .map_err(|_| trf!("Note not found: {rel}", "找不到笔记：{rel}"))?;
        let frontmatter = content
            .strip_prefix("---\n")
            .or_else(|| content.strip_prefix("---\r\n"))
            .and_then(|rest| rest.find("\n---").map(|end| rest[..end].to_string()));
        let pending = self.store.queued(&rel).map(|q| q.content);
        self.log("read", Some(&rel), None, 0, 0);
        Ok(
            json!({ "path": rel, "content": content, "frontmatter": frontmatter, "pendingReview": pending }),
        )
    }

    fn write_note(&mut self, args: &Value, direct: bool) -> Result<Value, String> {
        let (rel, abs) =
            self.resolve(arg_str(args, "path").ok_or(tr("Missing path", "缺少 path"))?)?;
        let mode = arg_str(args, "mode").unwrap_or("replace");
        let reason = arg_str(args, "reason").unwrap_or("").to_string();
        let current = self.current(&rel, &abs);
        let base = current.clone().unwrap_or_default();
        let next = match mode {
            "replace" => arg_str(args, "content")
                .ok_or(tr("replace needs content", "replace 需要 content"))?
                .to_string(),
            "append" => {
                let add = arg_str(args, "content")
                    .ok_or(tr("append needs content", "append 需要 content"))?;
                let sep = if base.is_empty() || base.ends_with('\n') {
                    ""
                } else {
                    "\n"
                };
                format!("{base}{sep}{add}")
            }
            "patch" => {
                let patches = args
                    .get("patch")
                    .and_then(Value::as_array)
                    .ok_or(tr("patch needs a patch array", "patch 需要 patch 数组"))?;
                let mut text =
                    current.ok_or_else(|| trf!("Note not found: {rel}", "找不到笔记：{rel}"))?;
                for (i, p) in patches.iter().enumerate() {
                    let old = arg_str(p, "old").ok_or_else(|| {
                        trf!("Patch {} is missing old", "第 {} 个 patch 缺少 old", i + 1)
                    })?;
                    let new = arg_str(p, "new").ok_or_else(|| {
                        trf!("Patch {} is missing new", "第 {} 个 patch 缺少 new", i + 1)
                    })?;
                    match text.matches(old).count() {
                        0 => {
                            return Err(trf!(
                                "Patch {}: old was not found in the current text",
                                "第 {} 个 patch 的 old 在当前内容里找不到",
                                i + 1
                            ))
                        }
                        1 => text = text.replacen(old, new, 1),
                        n => {
                            return Err(trf!(
                                "Patch {}: old appears {n} times; give a longer, unique snippet",
                                "第 {} 个 patch 的 old 出现了 {n} 次，请给出更长、唯一的片段",
                                i + 1
                            ))
                        }
                    }
                }
                text
            }
            other => return Err(trf!("Unsupported mode: {other}", "不支持的 mode：{other}")),
        };
        let disk = fs::read_to_string(&abs).unwrap_or_default();
        let (added, removed) = line_counts(&disk, &next);
        if direct {
            if let Some(dir) = abs.parent() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            zyrite_core::files::write_atomic(&abs, next.as_bytes()).map_err(|e| e.to_string())?;
            // 直接写入视为已接受：基线跟着更新，界面不再提示审阅
            let _ = self.store.set_baseline(&rel, &next);
            self.store.dequeue(&rel);
            self.log("write", Some(&rel), Some(reason), added, removed);
            return Ok(json!({ "written": true, "path": rel }));
        }
        let id = store::new_id("q");
        self.store
            .enqueue(&QueueItem {
                id: id.clone(),
                path: rel.clone(),
                content: next,
                agent: self.agent.clone(),
                reason: reason.clone(),
                created_ms: store::now_ms(),
            })
            .map_err(|e| e.to_string())?;
        self.log("write", Some(&rel), Some(reason), added, removed);
        Ok(json!({
            "queued": true,
            "id": id,
            "path": rel,
            "message": tr(
                "Submitted to the user's review queue; the file is written only after the user accepts it in Zyrite",
                "已提交到用户的审阅队列，用户在 Zyrite 里接受后才会写入文件"
            ),
        }))
    }

    fn list_backlinks(&mut self, args: &Value) -> Result<Value, String> {
        let (rel, _) =
            self.resolve(arg_str(args, "path").ok_or(tr("Missing path", "缺少 path"))?)?;
        let ix = self.index().map_err(|e| e.to_string())?;
        let back: Vec<Value> = ix
            .backlinks(&rel)
            .into_iter()
            .map(|m| json!({ "path": m.from, "line": m.line + 1, "context": m.context }))
            .collect();
        self.log("read", Some(&rel), Some("backlinks".into()), 0, 0);
        Ok(json!({ "backlinks": back }))
    }

    fn get_annotations(&mut self, args: &Value) -> Result<Value, String> {
        let list = match arg_str(args, "path") {
            Some(p) => self.store.annotations(&self.resolve(p)?.0),
            None => self.store.all_annotations(),
        };
        let want = arg_str(args, "status");
        let mut out = Vec::new();
        let mut texts: HashMap<String, String> = HashMap::new();
        for a in list {
            let text = texts
                .entry(a.file.clone())
                .or_insert_with(|| fs::read_to_string(self.root.join(&a.file)).unwrap_or_default())
                .clone();
            let located = locate(&text, &a.anchor);
            let status = if located.is_none() && a.status == "open" {
                "orphaned".to_string()
            } else {
                a.status.clone()
            };
            if want.is_some_and(|w| w != status) {
                continue;
            }
            let line = located.map(|(s, _)| text[..s].matches('\n').count() + 1);
            out.push(json!({
                "id": a.id,
                "path": a.file,
                "quote": a.anchor.text,
                "line": line,
                "comment": a.body,
                "assignee": a.assignee,
                "status": status,
                "thread": a.thread,
            }));
        }
        self.log("read", None, Some("annotations".into()), 0, 0);
        Ok(json!({ "annotations": out }))
    }

    fn reply_annotation(&mut self, args: &Value) -> Result<Value, String> {
        let id = arg_str(args, "id").ok_or(tr("Missing id", "缺少 id"))?;
        let message = arg_str(args, "message").ok_or(tr("Missing message", "缺少 message"))?;
        let status = arg_str(args, "status");
        if let Some(s) = status {
            if !["open", "changed", "resolved"].contains(&s) {
                return Err(trf!("Unsupported status: {s}", "不支持的状态：{s}"));
            }
        }
        let all = self.store.all_annotations();
        let file = all
            .iter()
            .find(|a| a.id == id)
            .map(|a| a.file.clone())
            .ok_or_else(|| trf!("Annotation not found: {id}", "找不到批注：{id}"))?;
        let mut list = self.store.annotations(&file);
        let a = list
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or_else(|| trf!("Annotation not found: {id}", "找不到批注：{id}"))?;
        a.thread.push(ThreadEntry {
            by: self.agent.clone(),
            at: store::now_ms().to_string(),
            text: message.to_string(),
        });
        if let Some(s) = status {
            a.status = s.to_string();
        }
        let result = json!({ "id": a.id, "status": a.status });
        self.store
            .save_annotations(&file, &list)
            .map_err(|e| e.to_string())?;
        self.log("reply", Some(&file), Some(id.to_string()), 0, 0);
        Ok(result)
    }

    /// 处理一条消息；通知（没有 id）不回复
    pub fn handle(&mut self, msg: &Value) -> Option<Value> {
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let result: Result<Value, (i64, String)> = match method {
            "initialize" => {
                if let Some(name) = params.pointer("/clientInfo/name").and_then(Value::as_str) {
                    self.agent = display_name(name);
                }
                let asked = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(PROTOCOL_VERSIONS[0]);
                let version = PROTOCOL_VERSIONS
                    .iter()
                    .find(|v| **v == asked)
                    .copied()
                    .unwrap_or(PROTOCOL_VERSIONS[0]);
                self.heartbeat();
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "zyrite", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": tr(INSTRUCTIONS_EN, INSTRUCTIONS_ZH),
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": Self::tools() })),
            "tools/call" => {
                self.heartbeat();
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                Ok(self.call_tool(name, &args))
            }
            m if m.starts_with("notifications/") => return None,
            _ => Err((-32601, format!("Method not found: {method}"))),
        };
        let id = id?;
        Some(match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err((code, message)) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
            }
        })
    }

    /// 读到输入结束为止
    pub fn serve(mut self, input: impl BufRead, mut output: impl Write) -> io::Result<()> {
        // 连着的时候每分钟报一次"还在"：Agent 常常只用自带的文件工具改文件、很久不调 MCP，
        // 没有这个心跳它会从"已连接"里掉出去，直接写盘的改动就认不出是谁写的
        let root = self.root.clone();
        std::thread::spawn(move || {
            let store = Store::new(&root);
            let pid = std::process::id();
            loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                // 只续已经登记过的（initialize 之后才有名字；断开后文件被删就不再写）
                if let Some(mut info) = store.agents().into_iter().find(|a| a.pid == pid) {
                    info.last_seen_ms = store::now_ms();
                    let _ = store.heartbeat(&info);
                }
            }
        });
        for line in input.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let reply = match serde_json::from_str::<Value>(&line) {
                Ok(Value::Array(batch)) => {
                    let replies: Vec<Value> = batch.iter().filter_map(|m| self.handle(m)).collect();
                    (!replies.is_empty()).then_some(Value::Array(replies))
                }
                Ok(msg) => self.handle(&msg),
                Err(e) => Some(
                    json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": e.to_string() } }),
                ),
            };
            if let Some(r) = reply {
                serde_json::to_writer(&mut output, &r)?;
                output.write_all(b"\n")?;
                output.flush()?;
            }
        }
        self.store.disconnect(std::process::id());
        Ok(())
    }
}

/// `zyrite mcp [--vault <库>] [--lang en|zh-CN]`；不给 --vault 时用当前目录。
/// 语言：--lang → ZYRITE_LANG 环境变量 → Zyrite 界面上次用的语言 → 英文
pub fn run_from_args(args: &[String]) -> io::Result<()> {
    let lang = args
        .iter()
        .position(|a| a == "--lang")
        .and_then(|i| args.get(i + 1));
    zyrite_i18n::set_locale(zyrite_i18n::resolve(lang.map(String::as_str)));
    let vault = args
        .iter()
        .position(|a| a == "--vault")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let vault = fs::canonicalize(&vault).unwrap_or(vault);
    let stdin = io::stdin();
    Server::new(vault).serve(stdin.lock(), io::stdout())
}

#[cfg(all(test, unix))]
mod exe_tests {
    use super::exe_of;

    #[test]
    fn 拿到的是完整路径() {
        let exe = exe_of(std::process::id()).unwrap();
        assert_eq!(
            std::fs::canonicalize(&exe).unwrap(),
            std::env::current_exe().unwrap().canonicalize().unwrap()
        );
    }
}
