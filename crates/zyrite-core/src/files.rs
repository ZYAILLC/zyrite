//! 读写 Markdown 文件。
//!
//! - 按字节原样读写：不转换换行符、不去 BOM，编辑器负责保真。
//! - 保存时先写同目录下的临时文件，再原子替换，写到一半崩溃不会留下半个文件。
//! - 读写都返回文件的"戳"（修改时间 + 大小）。保存时带上上次的戳，磁盘上的文件在这期间被别的程序
//!   （例如 Agent）改过就拒绝覆盖，交给界面让用户决定。

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize, Serializer};

/// 文件在磁盘上的状态，用来判断两次读写之间有没有被别的程序改过
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    /// 修改时间，Unix 毫秒
    pub modified_ms: u64,
    pub len: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedFile {
    pub path: String,
    pub text: String,
    pub stamp: Stamp,
}

#[derive(Debug, thiserror::Error)]
pub enum FileError {
    #[error("文件不存在：{0}")]
    NotFound(String),
    #[error("不是 UTF-8 编码的文本文件：{0}")]
    NotUtf8(String),
    #[error("已经存在：{0}")]
    Exists(String),
    #[error("文件已在外部被修改：{path}")]
    Conflict { path: String, current: Stamp },
    #[error("{0}")]
    Io(#[from] io::Error),
}

/// 传给前端：`{ kind, message, current? }`，界面按 kind 显示本地化文案
impl Serialize for FileError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a> {
            kind: &'a str,
            message: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            current: Option<Stamp>,
        }
        let (kind, current) = match self {
            FileError::NotFound(_) => ("notFound", None),
            FileError::NotUtf8(_) => ("notUtf8", None),
            FileError::Exists(_) => ("exists", None),
            FileError::Conflict { current, .. } => ("conflict", Some(*current)),
            FileError::Io(_) => ("io", None),
        };
        Payload {
            kind,
            message: self.to_string(),
            current,
        }
        .serialize(s)
    }
}

pub fn stamp_of(meta: &fs::Metadata) -> Stamp {
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Stamp {
        modified_ms,
        len: meta.len(),
    }
}

fn not_found_or(path: &Path, e: io::Error) -> FileError {
    if e.kind() == io::ErrorKind::NotFound {
        FileError::NotFound(path.display().to_string())
    } else {
        FileError::Io(e)
    }
}

/// 读取文本文件
pub fn read_text(path: &Path) -> Result<LoadedFile, FileError> {
    let bytes = fs::read(path).map_err(|e| not_found_or(path, e))?;
    let meta = fs::metadata(path).map_err(|e| not_found_or(path, e))?;
    let text =
        String::from_utf8(bytes).map_err(|_| FileError::NotUtf8(path.display().to_string()))?;
    Ok(LoadedFile {
        path: path.display().to_string(),
        text,
        stamp: stamp_of(&meta),
    })
}

/// 保存文本文件。`expected` 是上次读写时的戳：磁盘上的文件和它不一致就返回 `Conflict`，不写入。
/// 传 `None` 表示无条件覆盖（另存为、用户确认覆盖）。
pub fn save_text(path: &Path, text: &str, expected: Option<Stamp>) -> Result<Stamp, FileError> {
    // 符号链接：写到它指向的文件，不把链接本身换成普通文件
    let target = match fs::canonicalize(path) {
        Ok(p) => p,
        Err(e) if e.kind() == io::ErrorKind::NotFound => path.to_path_buf(),
        Err(e) => return Err(e.into()),
    };
    if let Some(expected) = expected {
        match fs::metadata(&target) {
            Ok(meta) => {
                let current = stamp_of(&meta);
                if current != expected {
                    return Err(FileError::Conflict {
                        path: target.display().to_string(),
                        current,
                    });
                }
            }
            // 文件在外部被删了：照常写出来
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    write_atomic(&target, text.as_bytes())?;
    Ok(stamp_of(&fs::metadata(&target)?))
}

/// 写临时文件再原子替换；沿用原文件的权限
pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let dir: PathBuf = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let mut tmp = tempfile::Builder::new()
        .prefix(".zyrite-")
        .suffix(".tmp")
        .tempfile_in(&dir)?;
    tmp.write_all(contents)?;
    tmp.as_file().sync_all()?;
    if let Ok(meta) = fs::metadata(path) {
        tmp.as_file().set_permissions(meta.permissions())?;
    } else {
        // 新文件：临时文件默认只有自己可读（0600），换成普通文件的 0644
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tmp.as_file()
                .set_permissions(fs::Permissions::from_mode(0o644))?;
        }
    }
    tmp.persist(path).map_err(|e| e.error)?;
    // 让目录项的改动也落盘（只有 Unix 能对目录 fsync）
    #[cfg(unix)]
    if let Ok(d) = fs::File::open(&dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn 新文件是_0644() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("new.md");
        write_atomic(&p, b"x").unwrap();
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }

    #[test]
    fn 原样读写_crlf_和_bom() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        let src = "\u{feff}# 标题\r\n\r\n正文\r\n";
        fs::write(&p, src).unwrap();
        let loaded = read_text(&p).unwrap();
        assert_eq!(loaded.text, src);
        save_text(&p, &loaded.text, Some(loaded.stamp)).unwrap();
        assert_eq!(fs::read(&p).unwrap(), src.as_bytes());
    }

    #[test]
    fn 不存在和非_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("none.md");
        assert!(matches!(read_text(&p), Err(FileError::NotFound(_))));
        fs::write(&p, [0xff, 0xfe, 0x00]).unwrap();
        assert!(matches!(read_text(&p), Err(FileError::NotUtf8(_))));
    }

    #[test]
    fn 外部修改过就拒绝覆盖() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        fs::write(&p, "v1").unwrap();
        let loaded = read_text(&p).unwrap();
        // 模拟 Agent 改了文件（长度变化，不依赖修改时间的精度）
        fs::write(&p, "agent wrote this").unwrap();
        let err = save_text(&p, "mine", Some(loaded.stamp)).unwrap_err();
        assert!(matches!(err, FileError::Conflict { .. }));
        assert_eq!(fs::read_to_string(&p).unwrap(), "agent wrote this");
        // 用户确认覆盖
        save_text(&p, "mine", None).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "mine");
    }

    #[test]
    fn 保存后返回新戳_可以连续保存() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        let s1 = save_text(&p, "one", None).unwrap();
        let s2 = save_text(&p, "two!", Some(s1)).unwrap();
        save_text(&p, "three", Some(s2)).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "three");
        // 目录里没有留下临时文件
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("a.md")]);
    }

    #[cfg(unix)]
    #[test]
    fn 保留权限_跟随符号链接() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.md");
        fs::write(&real, "x").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join("link.md");
        symlink(&real, &link).unwrap();
        save_text(&link, "y", None).unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "y");
        assert_eq!(
            fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn 错误序列化给前端() {
        let e = FileError::Conflict {
            path: "a.md".into(),
            current: Stamp {
                modified_ms: 1,
                len: 2,
            },
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "conflict");
        assert_eq!(v["current"]["modifiedMs"], 1);
        assert_eq!(
            serde_json::to_value(FileError::NotUtf8("x".into())).unwrap()["kind"],
            "notUtf8"
        );
    }
}
