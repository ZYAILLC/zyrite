//! 后端文案的语言：默认英文，可选简体中文。
//!
//! - 桌面端：界面启动时通过 `set_locale` 命令把界面语言传过来，并用 [`save_locale`] 记下来。
//! - `zyrite mcp`：按 `--lang` 参数 → `ZYRITE_LANG` 环境变量 → 桌面端记下的语言 → 英文 的顺序决定，见 [`resolve`]。
//!
//! 写文案时用 [`tr`]（不带参数）或 [`trf!`]（带格式化参数），英文在前、中文在后。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::{fs, io};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Locale {
    En,
    ZhCn,
}

impl Locale {
    /// 认 `en`、`en-US`、`zh-CN`、`zh` 这类写法，大小写不限；认不出返回 None
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim().to_ascii_lowercase().replace('_', "-");
        if s == "en" || s.starts_with("en-") || s == "english" {
            Some(Self::En)
        } else if s == "zh" || s.starts_with("zh-") {
            Some(Self::ZhCn)
        } else {
            None
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::ZhCn => "zh-CN",
        }
    }
}

static ZH: AtomicBool = AtomicBool::new(false);

pub fn set_locale(locale: Locale) {
    ZH.store(locale == Locale::ZhCn, Ordering::Relaxed);
}

pub fn locale() -> Locale {
    if is_zh() {
        Locale::ZhCn
    } else {
        Locale::En
    }
}

pub fn is_zh() -> bool {
    ZH.load(Ordering::Relaxed)
}

/// 按当前语言选一句不带参数的文案
pub fn tr<'a>(en: &'a str, zh: &'a str) -> &'a str {
    if is_zh() {
        zh
    } else {
        en
    }
}

/// 按当前语言选一句带参数的文案，用法和 `format!` 一样：`trf!("Not found: {path}", "找不到：{path}")`
#[macro_export]
macro_rules! trf {
    ($en:literal, $zh:literal $(,)?) => {
        if $crate::is_zh() { format!($zh) } else { format!($en) }
    };
    ($en:literal, $zh:literal, $($arg:tt)+) => {
        if $crate::is_zh() { format!($zh, $($arg)+) } else { format!($en, $($arg)+) }
    };
}

/// 和 tauri.conf.json 里的 identifier 一致：桌面端的配置目录
const APP_ID: &str = "ai.z-y.zyrite";

/// 系统的用户配置目录（与 Tauri 的 app_config_dir 规则一致）
fn config_dir() -> Option<PathBuf> {
    let home = || std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "macos") {
        home().map(|h| h.join("Library/Application Support"))
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| home().map(|h| h.join(".config")))
    }
}

/// 桌面端记下界面语言的文件
pub fn saved_locale_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join(APP_ID).join("locale"))
}

/// 记下桌面端的界面语言，给不带界面运行的 `zyrite mcp` 用
pub fn save_locale(locale: Locale) -> io::Result<()> {
    let path = saved_locale_path()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no config directory"))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, locale.code())
}

pub fn load_saved_locale() -> Option<Locale> {
    fs::read_to_string(saved_locale_path()?)
        .ok()
        .as_deref()
        .and_then(Locale::parse)
}

/// 不带界面运行时（`zyrite mcp`）用的语言：`--lang` 参数 → `ZYRITE_LANG` 环境变量 → 桌面端记下的语言 → 英文
pub fn resolve(arg: Option<&str>) -> Locale {
    arg.and_then(Locale::parse)
        .or_else(|| {
            std::env::var("ZYRITE_LANG")
                .ok()
                .as_deref()
                .and_then(Locale::parse)
        })
        .or_else(load_saved_locale)
        .unwrap_or(Locale::En)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 认得常见写法() {
        assert_eq!(Locale::parse("en"), Some(Locale::En));
        assert_eq!(Locale::parse("EN-us"), Some(Locale::En));
        assert_eq!(Locale::parse("zh-CN"), Some(Locale::ZhCn));
        assert_eq!(Locale::parse("zh_cn"), Some(Locale::ZhCn));
        assert_eq!(Locale::parse("zh"), Some(Locale::ZhCn));
        assert_eq!(Locale::parse("fr"), None);
        assert_eq!(Locale::parse(""), None);
    }

    #[test]
    fn 默认英文_切换后用中文() {
        assert_eq!(locale(), Locale::En);
        let n = 3;
        assert_eq!(tr("Saved", "已保存"), "Saved");
        assert_eq!(trf!("{n} files", "{n} 个文件"), "3 files");
        set_locale(Locale::ZhCn);
        assert_eq!(tr("Saved", "已保存"), "已保存");
        assert_eq!(trf!("{} files", "{} 个文件", n), "3 个文件");
        set_locale(Locale::En);
        assert_eq!(locale(), Locale::En);
    }

    #[test]
    fn 参数优先() {
        assert_eq!(resolve(Some("zh-CN")), Locale::ZhCn);
        assert_eq!(resolve(Some("en")), Locale::En);
    }
}
