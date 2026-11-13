//! 图片、导出、Typora 主题用到的命令。

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use zyrite_core::files;

fn b64() -> &'static base64::engine::GeneralPurpose {
    &base64::engine::general_purpose::STANDARD
}

/// 目标已存在时加 -1、-2… 找一个不重名的路径
fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = path.extension().and_then(|s| s.to_str());
    for i in 1.. {
        let name = match ext {
            Some(e) => format!("{stem}-{i}.{e}"),
            None => format!("{stem}-{i}"),
        };
        let candidate = path.with_file_name(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

fn allow_dir(app: &AppHandle, path: &Path) {
    if let Some(dir) = path.parent() {
        let _ = app.asset_protocol_scope().allow_directory(dir, true);
    }
}

/// 保存粘贴的图片（base64），不覆盖已有文件；返回实际写入的路径
#[tauri::command(async)]
pub fn image_write(app: AppHandle, path: PathBuf, data: String) -> Result<String, String> {
    let bytes = b64().decode(data.trim()).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let target = unique_path(&path);
    files::write_atomic(&target, &bytes).map_err(|e| e.to_string())?;
    allow_dir(&app, &target);
    Ok(target.to_string_lossy().into_owned())
}

/// 拖入的图片复制到模板位置；返回实际写入的路径
#[tauri::command(async)]
pub fn image_copy(app: AppHandle, from: PathBuf, to: PathBuf) -> Result<String, String> {
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let target = unique_path(&to);
    fs::copy(&from, &target).map_err(|e| e.to_string())?;
    allow_dir(&app, &target);
    Ok(target.to_string_lossy().into_owned())
}

/// 读文件为 base64（导出时把图片内嵌进 HTML / Word）
#[tauri::command(async)]
pub fn read_base64(path: PathBuf) -> Result<String, String> {
    fs::read(&path)
        .map(|b| b64().encode(b))
        .map_err(|e| e.to_string())
}

/// 写文本文件（导出 HTML）
#[tauri::command(async)]
pub fn write_text(path: PathBuf, text: String) -> Result<(), String> {
    files::write_atomic(&path, text.as_bytes()).map_err(|e| e.to_string())
}

/// 上传图床：PicGo / PicList 的本地 HTTP 接口，或自定义命令；返回图片 URL
#[tauri::command]
pub async fn image_upload(
    mode: String,
    picgo_url: String,
    command: String,
    path: String,
) -> Result<String, String> {
    match mode.as_str() {
        "picgo" => upload_picgo(&picgo_url, &path).await,
        "command" => tauri::async_runtime::spawn_blocking(move || upload_command(&command, &path))
            .await
            .map_err(|e| e.to_string())?,
        _ => Err(zyrite_i18n::tr("No image host is set up", "没有设置图床").into()),
    }
}

async fn upload_picgo(url: &str, path: &str) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct Reply {
        success: bool,
        #[serde(default)]
        result: Vec<String>,
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        msg: Option<String>,
    }
    let reply: Reply = reqwest::Client::new()
        .post(url)
        .json(&serde_json::json!({ "list": [path] }))
        .send()
        .await
        .map_err(|e| {
            zyrite_i18n::trf!(
                "Can't connect to PicGo / PicList ({url}): {e}",
                "连不上 PicGo / PicList（{url}）：{e}"
            )
        })?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    match reply.result.into_iter().next() {
        Some(u) if reply.success => Ok(u),
        _ => Err(reply
            .message
            .or(reply.msg)
            .unwrap_or_else(|| zyrite_i18n::tr("Upload failed", "上传失败").into())),
    }
}

/// 自定义命令：图片路径作为最后一个参数，输出里最后一个 http(s) 地址就是结果
fn upload_command(command: &str, path: &str) -> Result<String, String> {
    if command.trim().is_empty() {
        return Err(zyrite_i18n::tr("No upload command is set up", "没有设置上传命令").into());
    }
    let quoted = format!("\"{}\"", path.replace('"', "\\\""));
    let full = format!("{command} {quoted}");
    let output = if cfg!(windows) {
        Command::new("cmd").args(["/C", &full]).output()
    } else {
        Command::new("sh").args(["-c", &full]).output()
    }
    .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let url = stdout
        .split_whitespace()
        .rev()
        .find(|w| w.starts_with("http://") || w.starts_with("https://"));
    match url {
        Some(u) if output.status.success() => Ok(u.to_string()),
        _ => {
            let err = String::from_utf8_lossy(&output.stderr);
            Err(if err.trim().is_empty() {
                zyrite_i18n::tr(
                    "The command didn't output an image URL",
                    "命令没有输出图片地址",
                )
                .into()
            } else {
                err.trim().to_string()
            })
        }
    }
}

/// 导出 Word
#[tauri::command(async)]
pub fn export_docx(path: PathBuf, doc: zyrite_export::Doc) -> Result<(), String> {
    let mut out = Cursor::new(Vec::new());
    zyrite_export::write_docx(&doc, &mut out).map_err(|e| e.to_string())?;
    files::write_atomic(&path, out.get_ref()).map_err(|e| e.to_string())
}

/// 打印当前窗口（导出 PDF：系统打印对话框里选"存储为 PDF"）
#[tauri::command]
pub fn print_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

// ---------- Typora 主题 ----------

fn themes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("themes");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    Ok(dir)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeFile {
    name: String,
    path: String,
}

/// 已导入的 Typora 主题（主题目录里的 .css）
#[tauri::command(async)]
pub fn theme_list(app: AppHandle) -> Result<Vec<ThemeFile>, String> {
    let dir = themes_dir(&app)?;
    let mut out: Vec<ThemeFile> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("css")))
        .filter_map(|p| {
            Some(ThemeFile {
                name: p.file_stem()?.to_str()?.to_string(),
                path: p.to_string_lossy().into_owned(),
            })
        })
        .collect();
    out.sort_by_key(|f| f.name.to_lowercase());
    Ok(out)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// 导入 Typora 主题：复制 .css，以及同名的资源文件夹（字体、图片），和 Typora 的主题目录结构一样
#[tauri::command(async)]
pub fn theme_import(app: AppHandle, path: PathBuf) -> Result<ThemeFile, String> {
    import_theme(&themes_dir(&app)?, &path)
}

fn import_theme(dir: &Path, path: &Path) -> Result<ThemeFile, String> {
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|_| {
            path.extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("css"))
        })
        .ok_or(zyrite_i18n::tr("Not a .css file", "不是 .css 文件"))?
        .to_string();
    let css = fs::read_to_string(path)
        .map_err(|e| zyrite_i18n::trf!("Can't read {}: {e}", "读不到 {}：{e}", path.display()))?;
    let target = dir.join(format!("{name}.css"));
    fs::write(&target, &css).map_err(|e| e.to_string())?;
    // Typora 主题常把字体放在同名文件夹里（例如 drake.css + drake/），也有用别的文件夹名的，
    // 所以把 .css 旁边、在 url() / @import 里被引用到的文件夹都带上
    if let Some(src_dir) = path.parent() {
        for entry in fs::read_dir(src_dir).into_iter().flatten().flatten() {
            let p = entry.path();
            let Some(folder) = p.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let referenced = ["\"", "'", "(", "./"]
                .iter()
                .any(|pre| css.contains(&format!("{pre}{folder}/")));
            if p.is_dir() && (folder == name || referenced) {
                copy_dir(&p, &dir.join(folder)).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(ThemeFile {
        name,
        path: target.to_string_lossy().into_owned(),
    })
}

#[tauri::command(async)]
pub fn theme_remove(app: AppHandle, name: String) -> Result<(), String> {
    let dir = themes_dir(&app)?;
    let css = dir.join(format!("{name}.css"));
    if css.parent() != Some(dir.as_path()) {
        return Err(zyrite_i18n::tr("Invalid theme name", "主题名无效").into());
    }
    fs::remove_file(css).map_err(|e| e.to_string())
}

/// 读主题的 CSS（以及 @import 进来的文件），只允许读主题目录里的文件
#[tauri::command(async)]
pub fn theme_read(app: AppHandle, path: PathBuf) -> Result<String, String> {
    let dir = themes_dir(&app)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(&dir) {
        return Err(zyrite_i18n::tr(
            "Only files in the themes folder can be read",
            "只能读取主题目录里的文件",
        )
        .into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 重名时加序号() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.png");
        assert_eq!(unique_path(&p), p);
        fs::write(&p, b"x").unwrap();
        assert_eq!(unique_path(&p), dir.path().join("a-1.png"));
        fs::write(dir.path().join("a-1.png"), b"x").unwrap();
        assert_eq!(unique_path(&p), dir.path().join("a-2.png"));
    }

    #[test]
    fn 导入主题带上引用的文件夹() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        fs::create_dir_all(src.path().join("lapis")).unwrap();
        fs::write(src.path().join("lapis/font.ttf"), b"f").unwrap();
        fs::create_dir_all(src.path().join("shared-fonts")).unwrap();
        fs::write(src.path().join("shared-fonts/a.woff"), b"w").unwrap();
        fs::create_dir_all(src.path().join("data")).unwrap();
        fs::write(src.path().join("data/big.bin"), b"x").unwrap();
        let css = "@font-face{src:url('./shared-fonts/a.woff')} .x{background:url(lapis/font.ttf)} /* metadata/ */";
        fs::write(src.path().join("lapis.css"), css).unwrap();
        let f = import_theme(dst.path(), &src.path().join("lapis.css")).unwrap();
        assert_eq!(f.name, "lapis");
        assert!(dst.path().join("lapis.css").exists());
        assert!(dst.path().join("lapis/font.ttf").exists());
        assert!(dst.path().join("shared-fonts/a.woff").exists());
        assert!(!dst.path().join("data").exists(), "没被引用的文件夹不复制");
        assert!(import_theme(dst.path(), &src.path().join("nope.css")).is_err());
        assert!(import_theme(dst.path(), &src.path().join("lapis/font.ttf")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn 自定义命令取最后一个地址() {
        let url = upload_command(
            "echo uploading; echo https://img.example/a.png #",
            "/tmp/a b.png",
        )
        .unwrap();
        assert_eq!(url, "https://img.example/a.png");
        assert!(upload_command("echo no url", "/tmp/x.png").is_err());
        assert!(upload_command("exit 3", "/tmp/x.png").is_err());
    }
}

/// 系统剪贴板里的图片（PNG，base64）。WebKitGTK 粘贴图片时网页拿不到数据，由这里读
#[tauri::command(async)]
pub fn clipboard_image() -> Option<String> {
    let mut cb = arboard::Clipboard::new().ok()?;
    let img = cb.get_image().ok()?;
    let buf =
        image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned())?;
    let mut out = Cursor::new(Vec::new());
    buf.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(b64().encode(out.into_inner()))
}
