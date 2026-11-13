//! 库内数据目录 `.zyrite/`：审阅基线、审阅队列、批注、Agent 活动记录、库级设置。
//!
//! 应用和 MCP server（`zyrite mcp`）都直接读写这里：应用开着时通过文件监听实时看到 Agent 的写入和批注回复，
//! 应用没开时写入照样进队列，下次打开再审阅。
//!
//! ```text
//! .zyrite/
//! ├── config.json          库级设置（审阅、MCP 权限）
//! ├── snapshots/<路径>      每个文件的审阅基线（用户最后确认过的版本）
//! ├── queue/<路径>.json     MCP write_note 写入的待审阅内容
//! ├── annotations/<路径>.json 批注（唯一不能删的目录）
//! ├── activity.jsonl       Agent 读写记录
//! ├── agents/<pid>.json    已连接的 Agent（MCP server 的心跳）
//! ├── grants.json          MCP 接入授权（带签名，见 grants.rs）
//! ├── requests/<id>.json   等用户处理的授权请求
//! └── app.json             应用开着这个库（心跳）
//! ```

use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::files::write_atomic;
use crate::grants::{AccessRequest, AppPresence, Grant, APP_ALIVE_MS, WAIT_MS};

pub const DIR: &str = ".zyrite";

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// 带前缀的唯一 id：时间 + 进程号 + 计数，按时间有序
pub fn new_id(prefix: &str) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!(
        "{prefix}_{:x}{:04x}{:03x}",
        now_ms(),
        std::process::id() & 0xffff,
        n & 0xfff
    )
}

// ---------- 设置 ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewConfig {
    /// Agent 的写入先进审阅。关闭时外部写入直接视为已接受，只做高亮提示
    pub enabled: bool,
}

impl Default for ReviewConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpConfig {
    /// 读取和搜索
    pub read: bool,
    /// 写入（进审阅队列）
    pub write: bool,
    /// 直接写入，不经过审阅（默认关）
    pub direct_write: bool,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            read: true,
            write: true,
            direct_write: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultConfig {
    pub review: ReviewConfig,
    pub mcp: McpConfig,
}

// ---------- 审阅队列 ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: String,
    /// 相对库根目录
    pub path: String,
    /// 提议的完整内容
    pub content: String,
    pub agent: String,
    #[serde(default)]
    pub reason: String,
    pub created_ms: u64,
}

// ---------- 批注 ----------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub text: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEntry {
    pub by: String,
    /// RFC 3339 或毫秒时间戳字符串都接受；新写入的是毫秒
    pub at: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    /// 相对库根目录
    pub file: String,
    pub anchor: Anchor,
    pub body: String,
    /// 交给哪个 Agent；"any" 表示任意已连接的 Agent
    #[serde(default = "any")]
    pub assignee: String,
    /// open（待处理）、changed（Agent 已修改）、resolved（已解决）；
    /// orphaned（待处理的批注找不到位置）是读取时算出来的，不存
    pub status: String,
    #[serde(default)]
    pub thread: Vec<ThreadEntry>,
    pub created_at: String,
}

fn any() -> String {
    "any".into()
}

/// 在正文里重新找到批注的位置：所有出现 anchor.text 的地方里，前后文吻合得最多的那个。
/// 找不到返回 None（位置已失效）。返回字节区间。
pub fn locate(text: &str, anchor: &Anchor) -> Option<(usize, usize)> {
    if anchor.text.is_empty() {
        return None;
    }
    let common_suffix = |a: &str, b: &str| {
        a.chars()
            .rev()
            .zip(b.chars().rev())
            .take_while(|(x, y)| x == y)
            .count()
    };
    let common_prefix =
        |a: &str, b: &str| a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
    text.match_indices(anchor.text.as_str())
        .map(|(at, m)| {
            let end = at + m.len();
            let score = common_suffix(&text[..at], &anchor.prefix)
                + common_prefix(&text[end..], &anchor.suffix);
            (score, at, end)
        })
        // 分数相同取靠前的
        .max_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)))
        .map(|(_, s, e)| (s, e))
}

// ---------- 活动记录、已连接的 Agent ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub at_ms: u64,
    pub agent: String,
    /// read、search、write、reply、list
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default)]
    pub added: usize,
    #[serde(default)]
    pub removed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub pid: u32,
    pub name: String,
    pub started_ms: u64,
    pub last_seen_ms: u64,
}

/// 多久没有心跳就不算"已连接"
pub const AGENT_TIMEOUT_MS: u64 = 10 * 60 * 1000;

/// 进程还在不在：客户端直接杀掉 MCP server 时来不及清理心跳文件。
/// Linux 上看 /proc；其他平台靠心跳超时
fn process_alive(pid: u32) -> bool {
    let proc = Path::new("/proc");
    !proc.exists() || proc.join(pid.to_string()).exists()
}

// ---------- 读写 ----------

pub struct Store {
    root: PathBuf,
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    write_atomic(
        path,
        &serde_json::to_vec_pretty(value).map_err(io::Error::other)?,
    )
}

fn remove_file_and_empty_dirs(path: &Path, stop: &Path) {
    let _ = fs::remove_file(path);
    let mut dir = path.parent();
    while let Some(d) = dir {
        if d == stop || fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}

impl Store {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn dir(&self, sub: &str) -> PathBuf {
        self.root.join(DIR).join(sub)
    }

    /// 相对路径映射到 .zyrite 子目录下的同名文件（rel 用 `/` 分隔）
    fn mirror(&self, sub: &str, rel: &str, ext: &str) -> PathBuf {
        let mut p = self.dir(sub);
        for part in rel.split('/').filter(|s| !s.is_empty() && *s != "..") {
            p.push(part);
        }
        if !ext.is_empty() {
            let name = p
                .file_name()
                .map(|n| format!("{}{ext}", n.to_string_lossy()))
                .unwrap_or_default();
            p.set_file_name(name);
        }
        p
    }

    // 设置
    pub fn config(&self) -> VaultConfig {
        read_json(&self.root.join(DIR).join("config.json")).unwrap_or_default()
    }

    pub fn set_config(&self, config: &VaultConfig) -> io::Result<()> {
        write_json(&self.root.join(DIR).join("config.json"), config)
    }

    // 基线
    pub fn baseline(&self, rel: &str) -> Option<String> {
        fs::read_to_string(self.mirror("snapshots", rel, "")).ok()
    }

    pub fn set_baseline(&self, rel: &str, text: &str) -> io::Result<()> {
        let p = self.mirror("snapshots", rel, "");
        if let Some(dir) = p.parent() {
            fs::create_dir_all(dir)?;
        }
        write_atomic(&p, text.as_bytes())
    }

    pub fn remove_baseline(&self, rel: &str) {
        remove_file_and_empty_dirs(&self.mirror("snapshots", rel, ""), &self.dir("snapshots"));
    }

    // 队列：每个文件最多一份待审阅的提议，新的覆盖旧的
    pub fn enqueue(&self, item: &QueueItem) -> io::Result<()> {
        write_json(&self.mirror("queue", &item.path, ".json"), item)
    }

    pub fn queued(&self, rel: &str) -> Option<QueueItem> {
        read_json(&self.mirror("queue", rel, ".json"))
    }

    pub fn dequeue(&self, rel: &str) {
        remove_file_and_empty_dirs(&self.mirror("queue", rel, ".json"), &self.dir("queue"));
    }

    pub fn queue_list(&self) -> Vec<QueueItem> {
        let mut out = Vec::new();
        let mut stack = vec![self.dir("queue")];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if let Some(item) = read_json::<QueueItem>(&p) {
                    out.push(item);
                }
            }
        }
        out.sort_by_key(|i| i.created_ms);
        out
    }

    // 批注
    pub fn annotations(&self, rel: &str) -> Vec<Annotation> {
        read_json(&self.mirror("annotations", rel, ".json")).unwrap_or_default()
    }

    pub fn save_annotations(&self, rel: &str, list: &[Annotation]) -> io::Result<()> {
        let p = self.mirror("annotations", rel, ".json");
        if list.is_empty() {
            remove_file_and_empty_dirs(&p, &self.dir("annotations"));
            return Ok(());
        }
        write_json(&p, &list)
    }

    /// 所有文件的批注
    pub fn all_annotations(&self) -> Vec<Annotation> {
        let base = self.dir("annotations");
        let mut out = Vec::new();
        let mut stack = vec![base];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if let Some(list) = read_json::<Vec<Annotation>>(&p) {
                    out.extend(list);
                }
            }
        }
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        out
    }

    /// 文件改名或移动：基线、队列、批注跟着走
    pub fn rename(&self, from: &str, to: &str) {
        for (sub, ext) in [
            ("snapshots", ""),
            ("queue", ".json"),
            ("annotations", ".json"),
        ] {
            let a = self.mirror(sub, from, ext);
            let b = self.mirror(sub, to, ext);
            if a.exists() {
                if let Some(dir) = b.parent() {
                    let _ = fs::create_dir_all(dir);
                }
                let _ = fs::rename(&a, &b);
            }
        }
        // 队列项和批注里记的路径也要改
        if let Some(mut q) = self.queued(to) {
            q.path = to.to_string();
            let _ = self.enqueue(&q);
        }
        let mut list = self.annotations(to);
        if !list.is_empty() {
            for a in &mut list {
                a.file = to.to_string();
            }
            let _ = self.save_annotations(to, &list);
        }
    }

    // 活动记录
    pub fn log(&self, entry: &Activity) -> io::Result<()> {
        fs::create_dir_all(self.root.join(DIR))?;
        let mut line = serde_json::to_vec(entry).map_err(io::Error::other)?;
        line.push(b'\n');
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.root.join(DIR).join("activity.jsonl"))?
            .write_all(&line)
    }

    /// 最近的活动，最新的在前
    pub fn activity(&self, limit: usize) -> Vec<Activity> {
        let text =
            fs::read_to_string(self.root.join(DIR).join("activity.jsonl")).unwrap_or_default();
        text.lines()
            .rev()
            .filter_map(|l| serde_json::from_str(l).ok())
            .take(limit)
            .collect()
    }

    // 已连接的 Agent
    pub fn heartbeat(&self, agent: &AgentInfo) -> io::Result<()> {
        write_json(
            &self.dir("agents").join(format!("{}.json", agent.pid)),
            agent,
        )
    }

    pub fn disconnect(&self, pid: u32) {
        let _ = fs::remove_file(self.dir("agents").join(format!("{pid}.json")));
    }

    /// 最近有心跳的 Agent
    pub fn agents(&self) -> Vec<AgentInfo> {
        let now = now_ms();
        let mut out: Vec<AgentInfo> = fs::read_dir(self.dir("agents"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| read_json::<AgentInfo>(&e.path()))
            .filter(|a| {
                now.saturating_sub(a.last_seen_ms) < AGENT_TIMEOUT_MS && process_alive(a.pid)
            })
            .collect();
        out.sort_by_key(|a| std::cmp::Reverse(a.last_seen_ms));
        out
    }

    // ---------- MCP 接入授权（见 grants.rs） ----------

    pub fn grants(&self) -> Vec<Grant> {
        read_json(&self.root.join(DIR).join("grants.json")).unwrap_or_default()
    }

    pub fn save_grants(&self, list: &[Grant]) -> io::Result<()> {
        write_json(&self.root.join(DIR).join("grants.json"), &list)
    }

    fn request_path(&self, id: &str) -> PathBuf {
        // id 是 new_id 生成的，只含字母数字和下划线；防一手路径穿越
        let safe: String = id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        self.dir("requests").join(format!("{safe}.json"))
    }

    pub fn put_request(&self, r: &AccessRequest) -> io::Result<()> {
        write_json(&self.request_path(&r.id), r)
    }

    pub fn request(&self, id: &str) -> Option<AccessRequest> {
        read_json(&self.request_path(id))
    }

    pub fn remove_request(&self, id: &str) {
        let _ = fs::remove_file(self.request_path(id));
    }

    /// 还在等用户处理的请求（拒绝了的不算），早的在前
    pub fn requests(&self) -> Vec<AccessRequest> {
        let mut out: Vec<AccessRequest> = fs::read_dir(self.dir("requests"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| read_json::<AccessRequest>(&e.path()))
            .filter(|r| !r.denied && now_ms().saturating_sub(r.created_ms) < WAIT_MS + 5_000)
            .collect();
        out.sort_by_key(|r| r.created_ms);
        out
    }

    /// 应用开着这个库：定时调用
    pub fn app_heartbeat(&self, pid: u32) -> io::Result<()> {
        write_json(
            &self.root.join(DIR).join("app.json"),
            &AppPresence {
                pid,
                last_seen_ms: now_ms(),
            },
        )
    }

    /// 应用是不是开着这个库（能弹窗问用户）
    pub fn app_alive(&self) -> bool {
        read_json::<AppPresence>(&self.root.join(DIR).join("app.json"))
            .is_some_and(|a| now_ms().saturating_sub(a.last_seen_ms) < APP_ALIVE_MS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ann(id: &str, file: &str, text: &str) -> Annotation {
        Annotation {
            id: id.into(),
            file: file.into(),
            anchor: Anchor {
                text: text.into(),
                prefix: String::new(),
                suffix: String::new(),
            },
            body: "改一下".into(),
            assignee: "any".into(),
            status: "open".into(),
            thread: vec![],
            created_at: "1".into(),
        }
    }

    #[test]
    fn 基线_队列_批注_改名() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::new(dir.path());
        assert_eq!(s.baseline("docs/a.md"), None);
        s.set_baseline("docs/a.md", "v1").unwrap();
        assert_eq!(s.baseline("docs/a.md").as_deref(), Some("v1"));
        let item = QueueItem {
            id: new_id("q"),
            path: "docs/a.md".into(),
            content: "v2".into(),
            agent: "Claude Code".into(),
            reason: "补充".into(),
            created_ms: 1,
        };
        s.enqueue(&item).unwrap();
        assert_eq!(s.queue_list(), vec![item.clone()]);
        s.save_annotations("docs/a.md", &[ann("an_1", "docs/a.md", "v1")])
            .unwrap();

        s.rename("docs/a.md", "notes/b.md");
        assert_eq!(s.baseline("notes/b.md").as_deref(), Some("v1"));
        assert_eq!(s.queued("notes/b.md").unwrap().path, "notes/b.md");
        assert_eq!(s.annotations("notes/b.md")[0].file, "notes/b.md");
        assert!(s.queued("docs/a.md").is_none());

        s.dequeue("notes/b.md");
        assert!(s.queue_list().is_empty());
        s.save_annotations("notes/b.md", &[]).unwrap();
        assert!(s.all_annotations().is_empty());
        // 空目录清掉了
        assert!(!dir.path().join(".zyrite/queue/notes").exists());
    }

    #[test]
    fn 批注重新定位() {
        let text = "工具有五个工具。对外提供五个工具，写入进队列。";
        let a = Anchor {
            text: "五个工具".into(),
            prefix: "对外提供".into(),
            suffix: "，写入".into(),
        };
        let (s, e) = locate(text, &a).unwrap();
        assert_eq!(&text[..s], "工具有五个工具。对外提供");
        assert_eq!(&text[s..e], "五个工具");
        // 原文改了前后文：还能找到唯一的那一处
        assert!(locate(
            "现在是六个工具。",
            &Anchor {
                text: "六个工具".into(),
                ..a.clone()
            }
        )
        .is_some());
        assert_eq!(locate("全删了", &a), None);
    }

    #[test]
    fn 设置默认值和活动记录() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::new(dir.path());
        assert!(s.config().review.enabled && !s.config().mcp.direct_write);
        let mut c = s.config();
        c.mcp.direct_write = true;
        s.set_config(&c).unwrap();
        assert!(s.config().mcp.direct_write);
        for i in 0..3 {
            s.log(&Activity {
                at_ms: i,
                agent: "Claude Code".into(),
                action: "read".into(),
                path: Some("a.md".into()),
                detail: None,
                added: 0,
                removed: 0,
            })
            .unwrap();
        }
        assert_eq!(
            s.activity(2).iter().map(|a| a.at_ms).collect::<Vec<_>>(),
            vec![2, 1]
        );
        // 用本进程的 pid：心跳之外还会检查进程是否还在
        let pid = std::process::id();
        let me = AgentInfo {
            pid,
            name: "Cursor".into(),
            started_ms: now_ms(),
            last_seen_ms: now_ms(),
        };
        s.heartbeat(&me).unwrap();
        assert_eq!(s.agents(), vec![me]);
        s.disconnect(pid);
        assert!(s.agents().is_empty());
    }

    #[test]
    fn 授权请求和应用心跳() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::new(dir.path());
        assert!(!s.app_alive());
        s.app_heartbeat(1).unwrap();
        assert!(s.app_alive());

        let r = AccessRequest {
            id: new_id("r"),
            name: "Claude Code".into(),
            exe: "/x".into(),
            pid: 9,
            created_ms: now_ms(),
            denied: false,
        };
        s.put_request(&r).unwrap();
        assert_eq!(s.requests(), vec![r.clone()]);
        s.put_request(&AccessRequest {
            denied: true,
            ..r.clone()
        })
        .unwrap();
        assert!(s.requests().is_empty(), "拒绝了的不再列出");
        assert!(s.request(&r.id).unwrap().denied);
        s.remove_request(&r.id);
        assert!(s.request(&r.id).is_none());
        assert!(s.request("../../etc/passwd").is_none());

        assert!(s.grants().is_empty());
    }
}
