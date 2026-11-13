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
