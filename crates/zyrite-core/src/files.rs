//! 读写 Markdown 和其他文本文件。
//!
//! - 按字节原样读写：不转换换行符、不去 BOM，编辑器负责保真。
//! - 编码：默认 UTF-8；UTF-8 读不通时自动识别（GBK、Big5、Shift_JIS 等，UTF-16 看 BOM），
//!   保存时按原来的编码写回。原编码表示不了的字符不会悄悄丢掉，而是返回 `Unmappable` 交给界面。
//! - 保存时先写同目录下的临时文件，再原子替换，写到一半崩溃不会留下半个文件。
//! - 读写都返回文件的"戳"（修改时间 + 大小）。保存时带上上次的戳，磁盘上的文件在这期间被别的程序
//!   （例如 Agent）改过就拒绝覆盖，交给界面让用户决定。

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::{Deserialize, Serialize, Serializer};

/// 默认编码的名字（和 encoding_rs 的名字一致）
pub const UTF8: &str = "UTF-8";

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
    /// 文件的编码，例如 "UTF-8"、"GBK"、"Shift_JIS"、"UTF-16LE"
    pub encoding: String,
}

#[derive(Debug, thiserror::Error)]
pub enum FileError {
    #[error("{}", msg::not_found(.0))]
    NotFound(String),
    #[error("{}", msg::not_utf8(.0))]
    NotUtf8(String),
    /// 二进制文件（开头有空字节）：不当文本打开
    #[error("{}", msg::binary(.0))]
    Binary(String),
    /// 按指定的编码解不开（"按其他编码重新打开"时）
    #[error("{}", msg::decode(.path, .encoding))]
    Decode { path: String, encoding: String },
    /// 内容里有原编码表示不了的字符（比如在 GBK 文件里输入了表情）：没有写入
    #[error("{}", msg::unmappable(.path, .encoding))]
    Unmappable { path: String, encoding: String },
    #[error("{}", msg::exists(.0))]
    Exists(String),
    #[error("{}", msg::conflict(.path))]
    Conflict { path: String, current: Stamp },
    #[error("{0}")]
    Io(#[from] io::Error),
}

/// 错误文案，按当前界面语言（见 zyrite-i18n）
mod msg {
    use zyrite_i18n::trf;

    pub fn not_found(path: &str) -> String {
        trf!("File not found: {path}", "文件不存在：{path}")
    }

    pub fn not_utf8(path: &str) -> String {
        trf!(
            "Not a UTF-8 text file: {path}",
            "不是 UTF-8 编码的文本文件：{path}"
        )
    }

    pub fn binary(path: &str) -> String {
        trf!("Not a text file: {path}", "不是文本文件：{path}")
    }

    pub fn decode(path: &str, encoding: &str) -> String {
        trf!(
            "Can't read {path} as {encoding}",
            "不能按 {encoding} 编码读取：{path}"
        )
    }

    pub fn unmappable(path: &str, encoding: &str) -> String {
        trf!(
            "Some characters can't be saved in {encoding}: {path}",
            "有些字符不能用 {encoding} 编码保存：{path}"
        )
    }

    pub fn exists(path: &str) -> String {
        trf!("Already exists: {path}", "已经存在：{path}")
    }

    pub fn conflict(path: &str) -> String {
        trf!(
            "The file was changed outside Zyrite: {path}",
            "文件已在外部被修改：{path}"
        )
    }
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
            FileError::Binary(_) => ("binary", None),
            FileError::Decode { .. } => ("decode", None),
            FileError::Unmappable { .. } => ("unmappable", None),
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

/// 开头这么多字节里出现空字节，就当二进制文件（和 git 的判断方式一样）
const BINARY_SNIFF: usize = 8000;

/// 读取文本文件：UTF-8 读不通时自动识别编码。二进制文件返回 `Binary`，识别不出编码返回 `NotUtf8`
pub fn read_text(path: &Path) -> Result<LoadedFile, FileError> {
    let (bytes, meta) = read_bytes(path)?;
    let (text, encoding) = decode_auto(bytes, path)?;
    Ok(loaded(path, text, encoding, &meta))
}

/// 按指定的编码读取（"按其他编码重新打开"）；编码名用 WHATWG 的标签，例如 "gbk"、"big5"、"utf-16le"
pub fn read_text_as(path: &Path, encoding: &str) -> Result<LoadedFile, FileError> {
    let (bytes, meta) = read_bytes(path)?;
    let decode_err = || FileError::Decode {
        path: path.display().to_string(),
        encoding: encoding.to_string(),
    };
    let enc = Encoding::for_label(encoding.as_bytes()).ok_or_else(decode_err)?;
    let text = enc
        .decode_without_bom_handling_and_without_replacement(&bytes)
        .ok_or_else(decode_err)?
        .into_owned();
    Ok(loaded(path, text, enc.name(), &meta))
}

fn read_bytes(path: &Path) -> Result<(Vec<u8>, fs::Metadata), FileError> {
    let bytes = fs::read(path).map_err(|e| not_found_or(path, e))?;
    let meta = fs::metadata(path).map_err(|e| not_found_or(path, e))?;
    Ok((bytes, meta))
}

fn loaded(path: &Path, text: String, encoding: &str, meta: &fs::Metadata) -> LoadedFile {
    LoadedFile {
        path: path.display().to_string(),
        text,
        stamp: stamp_of(meta),
        encoding: encoding.to_string(),
    }
}

/// 识别编码并解码。BOM 原样留在文本里（UTF-8 是开头的 U+FEFF），保存时照样写回
fn decode_auto(bytes: Vec<u8>, path: &Path) -> Result<(String, &'static str), FileError> {
    // UTF-16 有空字节，要在二进制判断之前按 BOM 认出来
    for enc in [UTF_16LE, UTF_16BE] {
        let bom: &[u8] = if enc == UTF_16LE {
            &[0xff, 0xfe]
        } else {
            &[0xfe, 0xff]
        };
        if bytes.starts_with(bom) {
            return enc
                .decode_without_bom_handling_and_without_replacement(&bytes)
                .map(|t| (t.into_owned(), enc.name()))
                .ok_or_else(|| FileError::NotUtf8(path.display().to_string()));
        }
    }
    if bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0) {
        return Err(FileError::Binary(path.display().to_string()));
    }
    let bytes = match String::from_utf8(bytes) {
        Ok(text) => return Ok((text, UTF_8.name())),
        Err(e) => e.into_bytes(),
    };
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(&bytes, true);
    let enc = detector.guess(None, false);
    enc.decode_without_bom_handling_and_without_replacement(&bytes)
        .filter(|_| enc != UTF_8)
        .map(|t| (t.into_owned(), enc.name()))
        .ok_or_else(|| FileError::NotUtf8(path.display().to_string()))
}

/// 按编码把文本转成字节；原编码表示不了的字符返回 `Unmappable`
pub fn encode_text(path: &Path, text: &str, encoding: &str) -> Result<Vec<u8>, FileError> {
    let unmappable = || FileError::Unmappable {
        path: path.display().to_string(),
        encoding: encoding.to_string(),
    };
    let enc = if encoding.is_empty() {
        UTF_8
    } else {
        Encoding::for_label(encoding.as_bytes()).ok_or_else(unmappable)?
    };
    // encoding_rs 只解码 UTF-16、不编码（按网页标准会输出 UTF-8），这里自己转
    if enc == UTF_16LE || enc == UTF_16BE {
        let le = enc == UTF_16LE;
        return Ok(text
            .encode_utf16()
            .flat_map(|u| if le { u.to_le_bytes() } else { u.to_be_bytes() })
            .collect());
    }
    if enc == UTF_8 {
        return Ok(text.as_bytes().to_vec());
    }
    let (bytes, _, had_unmappable) = enc.encode(text);
    if had_unmappable {
        return Err(unmappable());
    }
    Ok(bytes.into_owned())
}

/// 保存 UTF-8 文本文件。`expected` 是上次读写时的戳：磁盘上的文件和它不一致就返回 `Conflict`，不写入。
/// 传 `None` 表示无条件覆盖（另存为、用户确认覆盖）。
pub fn save_text(path: &Path, text: &str, expected: Option<Stamp>) -> Result<Stamp, FileError> {
    save_text_as(path, text, expected, UTF8)
}

/// 按指定的编码保存（打开时识别出的编码）。先编码再检查戳，编码失败时什么都不写
pub fn save_text_as(
    path: &Path,
    text: &str,
    expected: Option<Stamp>,
    encoding: &str,
) -> Result<Stamp, FileError> {
    let bytes = encode_text(path, text, encoding)?;
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
    write_atomic(&target, &bytes)?;
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
        fs::write(&p, [0xff, 0xfe, 0x41]).unwrap();
        assert!(matches!(read_text(&p), Err(FileError::NotUtf8(_))));
        // 开头有空字节：二进制文件
        let bin = dir.path().join("tool.bin");
        fs::write(&bin, b"MZ\x00\x01text").unwrap();
        assert!(matches!(read_text(&bin), Err(FileError::Binary(_))));
        assert_eq!(
            serde_json::to_value(FileError::Binary("x".into())).unwrap()["kind"],
            "binary"
        );
    }

    #[test]
    fn 识别_gbk_并按原编码写回() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("旧日志.txt");
        let src =
            "服务器启动成功\r\n端口：8080\r\n警告：磁盘空间不足，请尽快清理旧的日志文件。\r\n";
        let (gbk, _, _) = encoding_rs::GBK.encode(src);
        fs::write(&p, &gbk).unwrap();
        let loaded = read_text(&p).unwrap();
        assert_eq!(loaded.text, src);
        assert_eq!(loaded.encoding, "GBK");
        // 原样写回：字节完全一致
        save_text_as(&p, &loaded.text, Some(loaded.stamp), &loaded.encoding).unwrap();
        assert_eq!(fs::read(&p).unwrap(), gbk.as_ref());
        // GBK 表示不了的字符：报错，文件不动
        let stamp = stamp_of(&fs::metadata(&p).unwrap());
        let err = save_text_as(&p, "表情 🎉", Some(stamp), "GBK").unwrap_err();
        assert!(matches!(err, FileError::Unmappable { .. }));
        assert_eq!(serde_json::to_value(&err).unwrap()["kind"], "unmappable");
        assert_eq!(fs::read(&p).unwrap(), gbk.as_ref());
    }

    #[test]
    fn utf16_按_bom_识别并原样写回() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.reg");
        let src = "\u{feff}Windows Registry Editor\r\n";
        let bytes: Vec<u8> = src.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        fs::write(&p, &bytes).unwrap();
        let loaded = read_text(&p).unwrap();
        assert_eq!(
            (loaded.text.as_str(), loaded.encoding.as_str()),
            (src, "UTF-16LE")
        );
        save_text_as(&p, &loaded.text, None, &loaded.encoding).unwrap();
        assert_eq!(fs::read(&p).unwrap(), bytes);
    }

    #[test]
    fn 按指定编码重新读取() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big5.txt");
        let (big5, _, _) = encoding_rs::BIG5.encode("繁體中文的說明文件");
        fs::write(&p, &big5).unwrap();
        let loaded = read_text_as(&p, "big5").unwrap();
        assert_eq!(
            (loaded.text.as_str(), loaded.encoding.as_str()),
            ("繁體中文的說明文件", "Big5")
        );
        // 按 UTF-8 读不通：报 decode
        let err = read_text_as(&p, "utf-8").unwrap_err();
        assert_eq!(serde_json::to_value(&err).unwrap()["kind"], "decode");
        assert!(read_text_as(&p, "no-such-encoding").is_err());
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
