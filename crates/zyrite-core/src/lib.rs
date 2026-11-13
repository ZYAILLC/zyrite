//! Zyrite 核心库。桌面应用（`apps/desktop/src-tauri`）只负责把这里的功能暴露给界面。
//! 索引、链接图、diff、审阅、批注以后也放在这里。

pub mod files;
pub mod grants;
pub mod index;
pub mod links;
pub mod recovery;
pub mod search;
pub mod store;
pub mod vault;
pub mod vectors;
pub mod watch;
