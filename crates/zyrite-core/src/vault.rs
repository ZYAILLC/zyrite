//! 库：遍历文件夹、文件树、文件操作。
//!
//! 忽略规则：以 `.` 开头的文件和目录（含 `.git`、`.zyrite`，以及保存时的临时文件）、`node_modules`，
//! 以及 `.zyriteignore`（gitignore 语法，任意层级都生效）。不读 `.gitignore`：被 git 忽略的笔记照样要能看到。
//! 不跟随指向目录的符号链接，避免循环。

use std::fs;
use std::io;
use std::path::{Component, Path};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use serde::Serialize;

use crate::files::FileError;

/// 一次最多列出的条目数，防止误打开整个磁盘时卡住
pub const DEFAULT_LIMIT: usize = 50_000;

pub const IGNORE_FILE: &str = ".zyriteignore";
const IGNORED_DIRS: &[&str] = &["node_modules"];
const MARKDOWN_EXT: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx"];
const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

fn has_ext(name: &str, exts: &[&str]) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| exts.iter().any(|e| e.eq_ignore_ascii_case(ext)))
}

pub fn is_markdown(name: &str) -> bool {
    has_ext(name, MARKDOWN_EXT)
}

pub fn is_image(name: &str) -> bool {
    has_ext(name, IMAGE_EXT)
}

fn walker(root: &Path) -> WalkBuilder {
    let mut b = WalkBuilder::new(root);
    b.hidden(true)
        .parents(false)
        .ignore(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .follow_links(false)
        .add_custom_ignore_filename(IGNORE_FILE)
        .filter_entry(|e| !IGNORED_DIRS.iter().any(|d| e.file_name() == *d));
    b
}

/// 相对路径，分隔符统一为 `/`
fn rel(root: &Path, path: &Path) -> Option<String> {
    let r = path.strip_prefix(root).ok()?;
    let parts: Vec<_> = r
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// 文件夹里的 Markdown 文件（相对路径），⌘P 快速打开用
pub fn list_markdown(root: &Path, limit: usize) -> io::Result<Vec<String>> {
    fs::read_dir(root)?; // 根目录读不了要报错
    let mut out = Vec::new();
    for entry in walker(root).build().flatten() {
        let is_file = entry
            .file_type()
            .is_some_and(|t| t.is_file() || t.is_symlink());
        if is_file && is_markdown(&entry.file_name().to_string_lossy()) {
            if let Some(r) = rel(root, entry.path()) {
                out.push(r);
            }
            if out.len() >= limit {
                break;
            }
        }
    }
    out.sort();
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    /// 相对库根目录的路径，分隔符为 `/`
    pub path: String,
    pub dir: bool,
}

/// 文件树：所有目录，加上 Markdown 和图片（`all_files` 时列出全部文件）
pub fn list_tree(root: &Path, all_files: bool, limit: usize) -> io::Result<Vec<TreeEntry>> {
    fs::read_dir(root)?;
    let mut out = Vec::new();
    for entry in walker(root).build().flatten() {
        let Some(kind) = entry.file_type() else {
            continue;
        };
        let Some(path) = rel(root, entry.path()) else {
            continue;
        }; // 根目录本身
        let name = entry.file_name().to_string_lossy();
        if kind.is_dir() {
            out.push(TreeEntry { path, dir: true });
        } else if all_files || is_markdown(&name) || is_image(&name) {
            out.push(TreeEntry { path, dir: false });
        }
        if out.len() >= limit {
            break;
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// `.zyrite/` 里需要通知界面的数据：queue、annotations、activity、agents、授权；其余（基线、缓存、应用心跳）不用
pub fn data_kind(rel: &Path) -> Option<&'static str> {
    let mut parts = rel.components().map(|c| c.as_os_str().to_string_lossy());
    if parts.next()? != crate::store::DIR {
        return None;
    }
    match parts.next()?.as_ref() {
        "queue" => Some("queue"),
        "annotations" => Some("annotations"),
        "activity.jsonl" => Some("activity"),
        "agents" => Some("agents"),
        "config.json" => Some("config"),
        "grants.json" => Some("grants"),
        "requests" => Some("requests"),
        _ => None,
    }
}

/// 相对路径里有没有以 `.` 开头的部分（`.zyrite/`、`.git/` 等不算库里的笔记）
pub fn is_hidden_rel(rel: &str) -> bool {
    rel.split('/').any(|s| s.starts_with('.'))
}

/// 文件监听用：判断一个路径是否被忽略（规则同上）
pub struct IgnoreRules {
    root: std::path::PathBuf,
    gitignore: Gitignore,
}

impl IgnoreRules {
    pub fn load(root: &Path) -> Self {
        let mut b = GitignoreBuilder::new(root);
        // 文件不存在时 add 返回错误，忽略即可
        let _ = b.add(root.join(IGNORE_FILE));
        let gitignore = b.build().unwrap_or_else(|_| Gitignore::empty());
        Self {
            root: root.to_path_buf(),
            gitignore,
        }
    }

    pub fn is_ignored(&self, path: &Path) -> bool {
        let Ok(r) = path.strip_prefix(&self.root) else {
            return false;
        };
        let hidden = r.components().any(|c| match c {
            Component::Normal(s) => {
                let s = s.to_string_lossy();
                s.starts_with('.') || IGNORED_DIRS.contains(&s.as_ref())
            }
            _ => false,
        });
        // .zyriteignore 本身变化也要通知（规则变了，文件树要刷新）；
        // .zyrite/ 里 Agent 协作的数据（审阅队列、批注、活动记录、已连接的 Agent）也要通知界面
        if r == Path::new(IGNORE_FILE) || data_kind(r).is_some() {
            return false;
        }
        hidden
            || self
                .gitignore
                .matched_path_or_any_parents(path, path.is_dir())
                .is_ignore()
    }
}

// ---------- 文件操作 ----------

fn exists_err(path: &Path, e: io::Error) -> FileError {
    if e.kind() == io::ErrorKind::AlreadyExists {
        FileError::Exists(path.display().to_string())
    } else {
        FileError::Io(e)
    }
}

/// 新建空文件；已存在时报 `Exists`，不覆盖
pub fn create_file(path: &Path) -> Result<(), FileError> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(|e| exists_err(path, e))
}

pub fn create_dir(path: &Path) -> Result<(), FileError> {
    fs::create_dir(path).map_err(|e| exists_err(path, e))
}

/// 重命名或移动；目标已存在时报 `Exists`（只改大小写的重命名除外）
pub fn rename(from: &Path, to: &Path) -> Result<(), FileError> {
    let case_only = from.to_string_lossy().to_lowercase() == to.to_string_lossy().to_lowercase();
    if !case_only && fs::symlink_metadata(to).is_ok() {
        return Err(FileError::Exists(to.display().to_string()));
    }
    if to.starts_with(from) && from != to {
        return Err(FileError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            "不能把文件夹移到它自己里面",
        )));
    }
    fs::rename(from, to).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => FileError::NotFound(from.display().to_string()),
        _ => FileError::Io(e),
    })
}

/// 移到系统回收站
pub fn trash(path: &Path) -> Result<(), FileError> {
    if fs::symlink_metadata(path).is_err() {
        return Err(FileError::NotFound(path.display().to_string()));
    }
    trash::delete(path).map_err(|e| FileError::Io(io::Error::other(e.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(root: &Path, p: &str) {
        let full = root.join(p);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, "x").unwrap();
    }

    fn sample() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for p in [
            "a.md",
            "docs/b.markdown",
            "docs/deep/c.MD",
            "docs/img/logo.png",
            "notes.txt",
            ".git/x.md",
            ".obsidian/y.md",
            "node_modules/pkg/README.md",
            ".zyrite/z.md",
            "drafts/secret.md",
            "docs/tmp.md",
        ] {
            touch(dir.path(), p);
        }
        fs::create_dir_all(dir.path().join("empty")).unwrap();
        fs::write(dir.path().join(IGNORE_FILE), "drafts/\n").unwrap();
        fs::write(dir.path().join("docs").join(IGNORE_FILE), "tmp.md\n").unwrap();
        dir
    }

    #[test]
    fn 列出_markdown_并忽略() {
        let dir = sample();
        let got = list_markdown(dir.path(), DEFAULT_LIMIT).unwrap();
        assert_eq!(got, vec!["a.md", "docs/b.markdown", "docs/deep/c.MD"]);
    }

    #[test]
    fn 文件树_含目录和图片() {
        let dir = sample();
        let got: Vec<_> = list_tree(dir.path(), false, DEFAULT_LIMIT)
            .unwrap()
            .into_iter()
            .map(|e| format!("{}{}", e.path, if e.dir { "/" } else { "" }))
            .collect();
        assert_eq!(
            got,
            vec![
                "a.md",
                "docs/",
                "docs/b.markdown",
                "docs/deep/",
                "docs/deep/c.MD",
                "docs/img/",
                "docs/img/logo.png",
                "empty/"
            ]
        );
        let all = list_tree(dir.path(), true, DEFAULT_LIMIT).unwrap();
        assert!(all.iter().any(|e| e.path == "notes.txt"));
    }

    #[test]
    fn 数量上限和根目录不存在() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..10 {
            touch(dir.path(), &format!("{i}.md"));
        }
        assert_eq!(list_markdown(dir.path(), 3).unwrap().len(), 3);
        assert!(list_markdown(Path::new("/definitely/not/here"), 10).is_err());
        assert!(list_tree(Path::new("/definitely/not/here"), false, 10).is_err());
    }

    #[test]
    fn 忽略规则() {
        let dir = sample();
        let rules = IgnoreRules::load(dir.path());
        let p = |s: &str| dir.path().join(s);
        assert!(rules.is_ignored(&p(".git/x.md")));
        assert!(rules.is_ignored(&p("docs/.zyrite-abc.tmp")));
        assert!(rules.is_ignored(&p("node_modules/pkg/README.md")));
        assert!(rules.is_ignored(&p("drafts/secret.md")));
        assert!(!rules.is_ignored(&p("docs/b.markdown")));
        assert!(!rules.is_ignored(&p(IGNORE_FILE)));
        // .zyrite 里协作数据要通知，基线不用
        assert!(!rules.is_ignored(&p(".zyrite/queue/docs/a.md.json")));
        assert!(!rules.is_ignored(&p(".zyrite/annotations/a.md.json")));
        assert!(!rules.is_ignored(&p(".zyrite/activity.jsonl")));
        assert!(rules.is_ignored(&p(".zyrite/snapshots/a.md")));
        assert!(rules.is_ignored(&p(".zyrite/x.tmp")));
    }

    #[test]
    fn 新建_重命名_不覆盖() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.md");
        create_file(&a).unwrap();
        assert!(matches!(create_file(&a), Err(FileError::Exists(_))));
        create_dir(&dir.path().join("sub")).unwrap();
        assert!(matches!(
            create_dir(&dir.path().join("sub")),
            Err(FileError::Exists(_))
        ));

        let b = dir.path().join("b.md");
        fs::write(&b, "b").unwrap();
        assert!(matches!(rename(&a, &b), Err(FileError::Exists(_))));
        rename(&a, &dir.path().join("sub/a.md")).unwrap();
        assert!(dir.path().join("sub/a.md").exists());
        // 只改大小写
        rename(&b, &dir.path().join("B.md")).unwrap();
        // 文件夹不能移进自己
        assert!(rename(&dir.path().join("sub"), &dir.path().join("sub/inner")).is_err());
        assert!(matches!(
            rename(&dir.path().join("nope.md"), &dir.path().join("x.md")),
            Err(FileError::NotFound(_))
        ));
    }
}
