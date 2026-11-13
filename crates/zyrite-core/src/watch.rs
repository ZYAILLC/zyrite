//! 文件监听：外部新增、修改、删除即时反映到文件树和编辑器。
//!
//! 用 notify 监听，200 毫秒防抖合并；按库的忽略规则过滤（保存时的临时文件 `.zyrite-*.tmp` 以 `.` 开头，
//! 自然被过滤）。只报告"现在的状态"：路径还在就是新增或修改，不在了就是删除，
//! 原子替换（先删后建、改名覆盖）因此表现为一次修改。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::{Deserialize, Serialize};

use crate::vault::IgnoreRules;

pub const DEBOUNCE: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Create,
    Modify,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// 绝对路径
    pub path: String,
    pub kind: ChangeKind,
    pub dir: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSpec {
    pub path: PathBuf,
    /// 库根目录递归监听；库外单独打开的文件只监听它所在的目录
    pub recursive: bool,
}

pub struct Watcher {
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

struct Filter {
    rules: Vec<IgnoreRules>,
}

impl Filter {
    fn ignored(&self, path: &Path) -> bool {
        // 被任何一个监听根的规则忽略就丢掉；不在任何根下的（不会发生）保留
        self.rules.iter().any(|r| r.is_ignored(path))
    }
}

fn classify(events: impl IntoIterator<Item = notify::Event>, filter: &Filter) -> Vec<Change> {
    // 同一路径多次事件合并：现在还在 → Create（有过创建）或 Modify；不在了 → Remove
    let mut seen: BTreeMap<PathBuf, bool> = BTreeMap::new();
    for ev in events {
        if matches!(ev.kind, EventKind::Access(_)) {
            continue;
        }
        let created = matches!(ev.kind, EventKind::Create(_));
        for p in ev.paths {
            if filter.ignored(&p) {
                continue;
            }
            let entry = seen.entry(p).or_insert(false);
            *entry |= created;
        }
    }
    seen.into_iter()
        .map(|(p, created)| {
            let meta = std::fs::metadata(&p);
            let kind = match &meta {
                Ok(_) if created => ChangeKind::Create,
                Ok(_) => ChangeKind::Modify,
                Err(_) => ChangeKind::Remove,
            };
            Change {
                path: p.display().to_string(),
                kind,
                dir: meta.is_ok_and(|m| m.is_dir()),
            }
        })
        .collect()
}

impl Watcher {
    pub fn start(
        specs: &[WatchSpec],
        on_change: impl Fn(Vec<Change>) + Send + 'static,
    ) -> notify::Result<Self> {
        let filter = Filter {
            rules: specs.iter().map(|s| IgnoreRules::load(&s.path)).collect(),
        };
        let mut debouncer = new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
            if let Ok(events) = res {
                let changes = classify(events.into_iter().map(|e| e.event), &filter);
                if !changes.is_empty() {
                    on_change(changes);
                }
            }
        })?;
        for s in specs {
            let mode = if s.recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };
            debouncer.watch(&s.path, mode)?;
        }
        Ok(Self {
            _debouncer: debouncer,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc;

    /// 收集一段时间内的变化
    fn collect(rx: &mpsc::Receiver<Vec<Change>>, wait: Duration) -> Vec<Change> {
        let mut out = Vec::new();
        let deadline = std::time::Instant::now() + wait;
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(batch) => out.extend(batch),
                Err(_) => break,
            }
        }
        out
    }

    #[test]
    fn 新增_修改_删除_并过滤忽略的路径() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join(".zyriteignore"), "drafts/\n").unwrap();
        fs::create_dir_all(root.join("drafts")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("old.md"), "old").unwrap();

        let (tx, rx) = mpsc::channel();
        let _w = Watcher::start(
            &[WatchSpec {
                path: root.clone(),
                recursive: true,
            }],
            move |c| {
                let _ = tx.send(c);
            },
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(100));

        fs::write(root.join("new.md"), "new").unwrap();
        fs::write(root.join("old.md"), "changed").unwrap();
        fs::write(root.join(".zyrite-tmp.tmp"), "x").unwrap();
        fs::write(root.join("drafts/secret.md"), "x").unwrap();
        fs::write(root.join("node_modules/x.md"), "x").unwrap();
        crate::files::write_atomic(&root.join("atomic.md"), b"a").unwrap();

        let changes = collect(&rx, Duration::from_secs(2));
        let find = |name: &str| {
            changes
                .iter()
                .find(|c| c.path == root.join(name).display().to_string())
        };
        assert_eq!(
            find("new.md").map(|c| c.kind),
            Some(ChangeKind::Create),
            "{changes:?}"
        );
        // macOS 的 FSEvents 会把改动已有文件也带上"创建"标记，报成 Create；其他平台是 Modify
        let old = find("old.md").map(|c| c.kind);
        if cfg!(target_os = "macos") {
            assert!(
                matches!(old, Some(ChangeKind::Modify | ChangeKind::Create)),
                "{changes:?}"
            );
        } else {
            assert_eq!(old, Some(ChangeKind::Modify), "{changes:?}");
        }
        assert!(find("atomic.md").is_some(), "{changes:?}");
        assert!(find(".zyrite-tmp.tmp").is_none());
        assert!(find("drafts/secret.md").is_none());
        assert!(find("node_modules/x.md").is_none());

        fs::remove_file(root.join("new.md")).unwrap();
        let changes = collect(&rx, Duration::from_secs(2));
        assert!(
            changes
                .iter()
                .any(|c| c.path.ends_with("new.md") && c.kind == ChangeKind::Remove),
            "{changes:?}"
        );
    }
}
