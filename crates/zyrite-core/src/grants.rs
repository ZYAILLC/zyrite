//! MCP 接入授权：哪个程序可以通过 `zyrite mcp` 访问哪个库。
//!
//! - Agent 第一次访问某个库时，`zyrite mcp` 在 `.zyrite/requests/` 里放一份请求，应用弹窗问用户；
//!   用户允许后应用把授权写进 `.zyrite/grants.json`，拒绝则把请求标成 denied。
//! - 授权记录跟着库走，但每条都带签名（HMAC-SHA256，密钥在系统钥匙串里，只有 Zyrite 能静默读取）：
//!   Agent 能改库里的文件，却伪造不出有效的签名，自己给自己加授权或放宽权限都会被当成无效。
//! - 签名里包含库的绝对路径：把授权文件复制到别的库不生效；库挪了位置或换了电脑要重新授权一次。
//!
//! 这是"知情和同意"，不是沙箱：能运行 `zyrite mcp` 的程序本来就能直接读写这些 Markdown 文件。

use std::path::{Path, PathBuf};

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// 签名密钥在系统钥匙串里的位置（和内置 AI 的 key 同一个 service）
pub const KEY_SERVICE: &str = "ai.z-y.zyrite";
pub const KEY_ACCOUNT: &str = "mcp-grant-key";

/// Agent 等用户点"允许 / 拒绝"最多多久
pub const WAIT_MS: u64 = 60_000;

/// 应用的心跳（`.zyrite/app.json`）多久以内算"应用开着这个库"
pub const APP_ALIVE_MS: u64 = 60_000;

/// 一条授权：某个程序（启动 `zyrite mcp` 的可执行文件 + 它自报的名字）可以访问这个库
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub id: String,
    /// 显示用的名字，例如 Claude Code
    pub name: String,
    /// 启动 MCP 的程序路径；拿不到时为空，只按名字匹配
    pub exe: String,
    /// 可以提交写入（进审阅队列）、回复批注；读取和搜索是授权本身就有的
    pub write: bool,
    /// 可以直接写入，不经过审阅
    #[serde(default)]
    pub direct_write: bool,
    pub created_ms: u64,
    #[serde(default)]
    pub sig: String,
}

/// 等用户处理的授权请求（`.zyrite/requests/<id>.json`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessRequest {
    pub id: String,
    pub name: String,
    pub exe: String,
    pub pid: u32,
    pub created_ms: u64,
    /// 用户点了拒绝；`zyrite mcp` 看到后删掉请求
    #[serde(default)]
    pub denied: bool,
}

/// 应用开着某个库时每隔一会儿写一次（`.zyrite/app.json`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPresence {
    pub pid: u32,
    pub last_seen_ms: u64,
}

fn canonical(vault: &Path) -> PathBuf {
    std::fs::canonicalize(vault).unwrap_or_else(|_| vault.to_path_buf())
}

/// 被签名的内容：库路径和授权的每个字段（sig 除外）
fn payload(vault: &Path, g: &Grant) -> String {
    format!(
        "zyrite-grant-v1\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        canonical(vault).display(),
        g.id,
        g.name,
        g.exe,
        u8::from(g.write),
        u8::from(g.direct_write),
        g.created_ms
    )
}

fn mac(key: &[u8], vault: &Path, g: &Grant) -> Hmac<Sha256> {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("HMAC 接受任意长度的密钥");
    m.update(payload(vault, g).as_bytes());
    m
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// 给授权签名（写进 sig）
pub fn sign(key: &[u8], vault: &Path, g: &mut Grant) {
    g.sig = hex(&mac(key, vault, g).finalize().into_bytes());
}

/// 签名对不对（常数时间比较）
pub fn verify(key: &[u8], vault: &Path, g: &Grant) -> bool {
    match unhex(&g.sig) {
        Some(sig) => mac(key, vault, g).verify_slice(&sig).is_ok(),
        None => false,
    }
}

/// 新的签名密钥：32 字节随机数，存钥匙串时用十六进制
pub fn new_key() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("系统随机数不可用");
    hex(&buf)
}

/// 钥匙串里存的十六进制密钥 → 字节
pub fn decode_key(stored: &str) -> Option<Vec<u8>> {
    unhex(stored.trim()).filter(|k| k.len() >= 16)
}

/// 路径里的一段是不是版本号或构建哈希：2.1.317、v22.1.0、91184d3d9ba3
fn is_version(part: &str) -> bool {
    let semver = part.strip_prefix('v').unwrap_or(part);
    let dotted = semver.starts_with(|c: char| c.is_ascii_digit())
        && semver.contains('.')
        && semver
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-+".contains(c));
    let hash = part.len() >= 8
        && part.chars().all(|c| c.is_ascii_hexdigit())
        && part.chars().any(|c| c.is_ascii_digit());
    dotted || hash
}

/// 两个路径是不是同一个程序：只有版本号、构建哈希那几段不同也算。
/// 很多工具（桌面版 Claude Code、Homebrew、nvm）的路径里带版本号，不这样比较每次升级都要重新允许。
pub fn same_program(a: &str, b: &str) -> bool {
    let parts = |p: &'_ str| -> Vec<String> {
        p.split(['/', '\\'])
            .map(|c| {
                if is_version(c) {
                    "*".to_string()
                } else {
                    c.to_string()
                }
            })
            .collect()
    };
    parts(a) == parts(b)
}

/// 这个程序有没有有效的授权：程序（版本号不算）和名字都对得上、签名有效
pub fn find<'a>(
    grants: &'a [Grant],
    key: Option<&[u8]>,
    vault: &Path,
    name: &str,
    exe: &str,
) -> Option<&'a Grant> {
    let key = key?;
    grants
        .iter()
        .find(|g| same_program(&g.exe, exe) && g.name == name && verify(key, vault, g))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant() -> Grant {
        Grant {
            id: "g1".into(),
            name: "Claude Code".into(),
            exe: "/opt/homebrew/bin/claude".into(),
            write: true,
            direct_write: false,
            created_ms: 1,
            sig: String::new(),
        }
    }

    #[test]
    fn 签名和校验() {
        let dir = tempfile::tempdir().unwrap();
        let key = decode_key(&new_key()).unwrap();
        let mut g = grant();
        sign(&key, dir.path(), &mut g);
        assert!(verify(&key, dir.path(), &g));
        assert!(find(
            std::slice::from_ref(&g),
            Some(&key),
            dir.path(),
            "Claude Code",
            "/opt/homebrew/bin/claude"
        )
        .is_some());
    }

    #[test]
    fn 篡改或换库都无效() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let key = decode_key(&new_key()).unwrap();
        let mut g = grant();
        sign(&key, a.path(), &mut g);

        // Agent 自己把直接写入打开
        let mut tampered = g.clone();
        tampered.direct_write = true;
        assert!(!verify(&key, a.path(), &tampered));
        // 换个名字冒充
        let mut renamed = g.clone();
        renamed.name = "Cursor".into();
        assert!(!verify(&key, a.path(), &renamed));
        // 复制到别的库
        assert!(!verify(&key, b.path(), &g));
        // 别的密钥签的
        let other = decode_key(&new_key()).unwrap();
        assert!(!verify(&other, a.path(), &g));
        // 没有密钥（钥匙串里没有）：一律无效
        assert!(find(
            std::slice::from_ref(&g),
            None,
            a.path(),
            "Claude Code",
            "/opt/homebrew/bin/claude"
        )
        .is_none());
        // 程序路径不同
        assert!(find(
            std::slice::from_ref(&g),
            Some(&key),
            a.path(),
            "Claude Code",
            "/tmp/fake"
        )
        .is_none());
    }

    #[test]
    fn 升级后还是同一个程序() {
        // 桌面版 Claude Code、原生安装、Homebrew、nvm
        for (old, new) in [
            (
                "/Users/a/Claude/claude-code/2.1.317/91184d3d9ba3/claude.app/Contents/MacOS/claude",
                "/Users/a/Claude/claude-code/2.2.0/0a1b2c3d4e5f/claude.app/Contents/MacOS/claude",
            ),
            (
                "/Users/a/.local/share/claude/versions/2.1.154",
                "/Users/a/.local/share/claude/versions/2.1.200",
            ),
            (
                "/opt/homebrew/Cellar/node/22.1.0/bin/node",
                "/opt/homebrew/Cellar/node/24.0.1_1/bin/node",
            ),
            (
                "/Users/a/.nvm/versions/node/v20.1.0/bin/node",
                "/Users/a/.nvm/versions/node/v22.3.0/bin/node",
            ),
        ] {
            assert!(same_program(old, new), "{old}");
        }
        // 不同的程序、不同的位置、只有名字的，都不算
        for (a, b) in [
            ("/opt/homebrew/bin/claude", "/tmp/claude"),
            ("/opt/homebrew/bin/claude", "/opt/homebrew/bin/cursor"),
            ("/opt/homebrew/bin/claude", "claude"),
            ("/opt/2.0/claude", "/tmp/2.0/claude"),
            ("/opt/notes/claude", "/opt/deadbeef/claude"),
            ("/opt/homebrew/bin/claude", ""),
        ] {
            assert!(!same_program(a, b), "{a} {b}");
        }

        let dir = tempfile::tempdir().unwrap();
        let key = decode_key(&new_key()).unwrap();
        let mut g = grant();
        g.exe = "/a/claude-code/2.1.317/claude".into();
        sign(&key, dir.path(), &mut g);
        assert!(find(
            std::slice::from_ref(&g),
            Some(&key),
            dir.path(),
            "Claude Code",
            "/a/claude-code/2.2.0/claude"
        )
        .is_some());
    }

    #[test]
    fn 密钥格式() {
        assert_eq!(new_key().len(), 64);
        assert!(decode_key("zz").is_none());
        assert!(decode_key("abcd").is_none());
    }
}
