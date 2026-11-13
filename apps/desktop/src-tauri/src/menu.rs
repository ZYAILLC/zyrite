//! macOS 菜单栏：在默认的应用菜单里加"设置…"（About 下面，⌘,）。
//! 其他系统窗口上没有菜单栏，设置从快捷键和命令面板进。

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{App, AppHandle, Emitter, Manager, Wry};

/// 点了菜单里的"设置…"，没有载荷
const OPEN_SETTINGS: &str = "zyrite://open-settings";
const SETTINGS_ID: &str = "settings";

struct SettingsItem(MenuItem<Wry>);

pub fn install(app: &App) -> tauri::Result<()> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let h = app.handle();
    let menu = Menu::default(h)?;
    let item = MenuItem::with_id(h, SETTINGS_ID, "Settings…", true, Some("CmdOrCtrl+,"))?;
    if let Some(MenuItemKind::Submenu(first)) = menu.items()?.first() {
        // 默认的应用菜单是 About、分隔线、Services……：插到 About 和原来的分隔线之间
        first.insert_items(&[&PredefinedMenuItem::separator(h)?, &item], 1)?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, e| {
        if e.id() == SETTINGS_ID {
            let _ = app.emit(OPEN_SETTINGS, ());
        }
    });
    app.manage(SettingsItem(item));
    Ok(())
}

/// 菜单文字跟随界面语言（语言设置在前端）
#[tauri::command]
pub fn menu_localize(app: AppHandle, settings: String) {
    if let Some(item) = app.try_state::<SettingsItem>() {
        let _ = item.0.set_text(settings);
    }
}

/// 后端文案（错误信息等）跟随界面语言；同时记下来，给不带界面运行的 `zyrite mcp` 用
#[tauri::command]
pub fn set_locale(locale: String) {
    let locale = zyrite_i18n::Locale::parse(&locale).unwrap_or(zyrite_i18n::Locale::En);
    zyrite_i18n::set_locale(locale);
    if zyrite_i18n::load_saved_locale() != Some(locale) {
        let _ = zyrite_i18n::save_locale(locale);
    }
}
