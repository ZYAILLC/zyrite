//! 恢复缓存（崩溃不丢内容）。
//!
//! 只存一份"会话"：当前打开的文件路径，以及还没保存的内容（编辑中每 2 秒写一次）。
//! 下次启动时：有未保存内容就还原并标为未保存；没有就重新打开上次的文件。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::files::{write_atomic, Stamp};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// 打开的文件；`None` 是还没保存过的新文档
    pub path: Option<String>,
    /// 未保存的内容；`None` 表示没有未保存的修改
    pub text: Option<String>,
    /// 打开（或上次保存）时文件的戳，还原后保存时用来检查外部修改
    pub stamp: Option<Stamp>,
    /// 写入时间，Unix 毫秒
    pub updated_ms: u64,
    /// 打开的文件夹（⌘P 在这里找文件）；旧版本的会话没有这个字段
    #[serde(default)]
    pub folder: Option<String>,
}

pub struct RecoveryStore {
    dir: PathBuf,
}

impl RecoveryStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn file(&self) -> PathBuf {
        self.dir.join("session.json")
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 读不到或内容损坏都当作没有会话
    pub fn load(&self) -> Option<Session> {
        let bytes = fs::read(self.file()).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub fn save(&self, session: &Session) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let json = serde_json::to_vec(session).map_err(io::Error::other)?;
        write_atomic(&self.file(), &json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 存取会话() {
        let dir = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(dir.path().join("recovery"));
        assert_eq!(store.load(), None);
        let s = Session {
            path: Some("/a/b.md".into()),
            text: Some("未保存\r\n".into()),
            stamp: Some(Stamp {
                modified_ms: 5,
                len: 6,
            }),
            updated_ms: 7,
            folder: Some("/a".into()),
        };
        store.save(&s).unwrap();
        assert_eq!(store.load(), Some(s));
    }

    #[test]
    fn 兼容没有_folder_的旧会话() {
        let dir = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(dir.path());
        fs::write(
            dir.path().join("session.json"),
            r#"{"path":null,"text":null,"stamp":null,"updatedMs":1}"#,
        )
        .unwrap();
        assert_eq!(store.load().unwrap().folder, None);
    }

    #[test]
    fn 损坏的文件当作没有() {
        let dir = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(dir.path());
        fs::write(dir.path().join("session.json"), "{oops").unwrap();
        assert_eq!(store.load(), None);
    }
}
