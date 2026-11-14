//! Zyrite 桌面应用入口。业务逻辑放在 `crates/` 下的独立 crate 里，这里只负责组装和暴露命令。
//!
//! 读写磁盘、查索引的命令都标成 `async`：Tauri 里不带 async 的命令跑在主线程上，
//! 1 万篇的库里查反向链接、列笔记名单要几十毫秒，会卡住界面。

mod access;
mod ai;
mod media;
mod menu;
mod pdf;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use zyrite_core::files::{self, FileError, LoadedFile, Stamp};
use zyrite_core::index::{Index, Mention, NoteName, RenamePlan, TagCount};
use zyrite_core::recovery::{RecoveryStore, Session};
use zyrite_core::search::SearchResult;
use zyrite_core::store::{Activity, AgentInfo, Annotation, QueueItem, Store, VaultConfig};
use zyrite_core::vault::{self, TreeEntry};
use zyrite_core::watch::{WatchSpec, Watcher};

/// 文件变化事件名，载荷是 `Vec<Change>`
const FS_CHANGED: &str = "zyrite://fs-changed";

/// 索引更新事件名（链接、标签变了），没有载荷
const INDEX_CHANGED: &str = "zyrite://index-changed";
/// `.zyrite/` 里 Agent 协作的数据变了，载荷是变化的种类（queue、annotations、activity、agents、config、grants、requests）
const DATA_CHANGED: &str = "zyrite://data-changed";

/// 当前的文件监听；换库或换文件时整体替换
#[derive(Default)]
struct WatchState(Mutex<Option<Watcher>>);

/// 当前库的链接和标签索引
#[derive(Default)]
pub(crate) struct IndexState(pub(crate) Mutex<Option<Index>>);

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 把阻塞的磁盘操作放到后台线程，不卡界面
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, FileError> + Send + 'static,
) -> Result<T, FileError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| FileError::Io(std::io::Error::other(e)))?
}

/// 允许正文里的相对路径图片通过 asset 协议显示：放行文档所在目录
fn allow_doc_dir(app: &AppHandle, path: &Path) {
    if let Some(dir) = path.parent() {
        let _ = app.asset_protocol_scope().allow_directory(dir, true);
    }
}

/// 放行图片目录：打开的文件夹、拖进来的文件所在目录（正文里的 `../assets/x.png` 这类图片才能显示）
#[tauri::command(async)]
fn allow_asset_dirs(app: AppHandle, paths: Vec<PathBuf>) {
    let scope = app.asset_protocol_scope();
    for p in paths {
        let dir = if p.is_dir() {
            Some(p.as_path())
        } else {
            p.parent()
        };
        if let Some(dir) = dir {
            let _ = scope.allow_directory(dir, true);
        }
    }
}

#[tauri::command(async)]
fn open_file(app: AppHandle, path: PathBuf) -> Result<LoadedFile, FileError> {
    let loaded = files::read_text(&path)?;
    allow_doc_dir(&app, &path);
    Ok(loaded)
}

/// 按指定的编码重新打开（状态栏的编码菜单）
#[tauri::command(async)]
fn open_file_as(app: AppHandle, path: PathBuf, encoding: String) -> Result<LoadedFile, FileError> {
    let loaded = files::read_text_as(&path, &encoding)?;
    allow_doc_dir(&app, &path);
    Ok(loaded)
}

/// 保存；encoding 是打开时识别出的编码（不传为 UTF-8）
#[tauri::command(async)]
fn save_file(
    app: AppHandle,
    path: PathBuf,
    text: String,
    expected: Option<Stamp>,
    encoding: Option<String>,
) -> Result<Stamp, FileError> {
    let encoding = encoding.unwrap_or_else(|| files::UTF8.to_string());
    let stamp = files::save_text_as(&path, &text, expected, &encoding)?;
    allow_doc_dir(&app, &path);
    Ok(stamp)
}

#[tauri::command(async)]
fn session_load(store: State<'_, RecoveryStore>) -> Option<Session> {
    store.load()
}

#[tauri::command(async)]
fn session_save(store: State<'_, RecoveryStore>, mut session: Session) -> Result<(), FileError> {
    session.updated_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    Ok(store.save(&session)?)
}

/// 文件夹里能打开编辑的文件（Markdown 和文本文件，相对路径），⌘P 快速打开用
#[tauri::command]
async fn list_documents(root: PathBuf) -> Result<Vec<String>, FileError> {
    blocking(move || Ok(vault::list_documents(&root, vault::DEFAULT_LIMIT)?)).await
}

/// 文件树（相对路径）
#[tauri::command]
async fn list_tree(root: PathBuf, all_files: bool) -> Result<Vec<TreeEntry>, FileError> {
    blocking(move || Ok(vault::list_tree(&root, all_files, vault::DEFAULT_LIMIT)?)).await
}

/// 拖入的路径是不是文件夹（拖进文件夹时当作库打开）
#[tauri::command(async)]
fn is_dir(path: PathBuf) -> bool {
    path.is_dir()
}

#[tauri::command(async)]
fn create_file(path: PathBuf) -> Result<(), FileError> {
    vault::create_file(&path)
}

#[tauri::command(async)]
fn create_dir(path: PathBuf) -> Result<(), FileError> {
    vault::create_dir(&path)
}

/// 改名或移动；update_links 时同时改写所有指向它的链接，返回被改写的文件
#[tauri::command(async)]
fn rename_path(
    state: State<'_, IndexState>,
    from: PathBuf,
    to: PathBuf,
    update_links: bool,
) -> Result<Vec<String>, FileError> {
    // 必须在改名之前、用改名前的索引算出要改的链接
    let plan = if update_links {
        rename_plan(&state, &from, &to)
    } else {
        None
    };
    let moved = vault_store(&state, &from)
        .zip(vault_store(&state, &to))
        .map(|((s, a), (_, b))| (s, a, b));
    vault::rename(&from, &to)?;
    // 审阅基线、队列、批注跟着文件走
    if let Some((s, a, b)) = &moved {
        s.rename(a, b);
    }
    let mut updated = Vec::new();
    if let Some((root, plan)) = plan {
        let store = Store::new(&root);
        for (rel, text) in plan.files {
            let path = root.join(&rel);
            if files::write_atomic(&path, text.as_bytes()).is_ok() {
                // 用户自己发起的改写，不算 Agent 的改动，基线一起更新
                let _ = store.set_baseline(&rel, &text);
                updated.push(path.display().to_string());
            }
        }
    }
    Ok(updated)
}

/// 改名后要改写的链接数（界面据此询问是否更新）
#[tauri::command(async)]
fn count_link_updates(state: State<'_, IndexState>, from: PathBuf, to: PathBuf) -> usize {
    rename_plan(&state, &from, &to).map_or(0, |(_, p)| p.links)
}

fn rename_plan(state: &IndexState, from: &Path, to: &Path) -> Option<(PathBuf, RenamePlan)> {
    let guard = lock(&state.0);
    let ix = guard.as_ref()?;
    let rel = |p: &Path| {
        let r = p.strip_prefix(ix.root()).ok()?;
        Some(
            r.components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
        )
    };
    let plan = ix.plan_rename(&rel(from)?, &rel(to)?);
    Some((ix.root().to_path_buf(), plan))
}

#[tauri::command]
async fn trash_path(path: PathBuf) -> Result<(), FileError> {
    blocking(move || vault::trash(&path)).await
}

/// 替换当前的文件监听；specs 为空时停止监听
#[tauri::command(async)]
fn watch(
    app: AppHandle,
    state: State<'_, WatchState>,
    specs: Vec<WatchSpec>,
) -> Result<(), FileError> {
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    *slot = None;
    if specs.is_empty() {
        return Ok(());
    }
    let emitter = app.clone();
    let watcher = Watcher::start(&specs, move |changes| {
        let state = emitter.state::<IndexState>();
        // .zyrite/ 里的协作数据单独通知；其余是库里的文件
        let mut data: Vec<&'static str> = Vec::new();
        let mut files = Vec::new();
        {
            let slot = lock(&state.0);
            for c in changes {
                let kind = slot.as_ref().and_then(|ix| {
                    Path::new(&c.path)
                        .strip_prefix(ix.root())
                        .ok()
                        .and_then(vault::data_kind)
                });
                match kind {
                    Some(k) => {
                        if !data.contains(&k) {
                            data.push(k);
                        }
                    }
                    None => files.push(c),
                }
            }
        }
        // 先补审阅基线、更新索引，再通知界面，界面收到通知时查到的已经是新的
        let index_changed = {
            let mut slot = lock(&state.0);
            slot.as_mut().is_some_and(|ix| {
                ensure_baselines(ix, &files);
                ix.apply_changes(&files)
            })
        };
        if !files.is_empty() {
            let _ = emitter.emit(FS_CHANGED, files);
        }
        if !data.is_empty() {
            let _ = emitter.emit(DATA_CHANGED, data);
        }
        if index_changed {
            let _ = emitter.emit(INDEX_CHANGED, ());
        }
    })
    .map_err(|e| FileError::Io(std::io::Error::other(e.to_string())))?;
    *slot = Some(watcher);
    Ok(())
}

/// 被外部改写的笔记如果还没有审阅基线，用索引里记着的旧全文补一个（没打开过的文件被 Agent 改了也能审阅）
fn ensure_baselines(ix: &Index, changes: &[zyrite_core::watch::Change]) {
    let store = Store::new(ix.root());
    for c in changes {
        if c.kind != zyrite_core::watch::ChangeKind::Modify {
            continue;
        }
        if let Some(rel) = ix.rel_of(Path::new(&c.path)) {
            if store.baseline(&rel).is_none() {
                if let Some(old) = ix.text_of(&rel) {
                    let _ = store.set_baseline(&rel, old);
                }
            }
        }
    }
}

/// 当前库的 `.zyrite/` 和文件的相对路径；不在库里返回 None
fn vault_store(state: &IndexState, path: &Path) -> Option<(Store, String)> {
    let guard = lock(&state.0);
    let ix = guard.as_ref()?;
    let r = path.strip_prefix(ix.root()).ok()?;
    let rel = r
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    Some((Store::new(ix.root()), rel))
}

pub(crate) fn current_store(state: &IndexState) -> Option<Store> {
    lock(&state.0).as_ref().map(|ix| Store::new(ix.root()))
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewData {
    baseline: Option<String>,
    queued: Option<QueueItem>,
}

/// 审阅用的数据：基线和 MCP 写入的待审阅内容
#[tauri::command(async)]
fn review_get(state: State<'_, IndexState>, path: PathBuf) -> ReviewData {
    match vault_store(&state, &path) {
        Some((s, rel)) => ReviewData {
            baseline: s.baseline(&rel),
            queued: s.queued(&rel),
        },
        None => ReviewData::default(),
    }
}

/// 设置审阅基线（打开、保存、接受改动后）；text 为 null 时删除
#[tauri::command(async)]
fn baseline_set(
    state: State<'_, IndexState>,
    path: PathBuf,
    text: Option<String>,
) -> Result<(), FileError> {
    let Some((s, rel)) = vault_store(&state, &path) else {
        return Ok(());
    };
    match text {
        Some(t) => s.set_baseline(&rel, &t)?,
        None => s.remove_baseline(&rel),
    }
    Ok(())
}

/// 更新 MCP 写入的待审阅内容（拒绝其中一处后）；content 为 null 时移出队列
#[tauri::command(async)]
fn queue_set(
    state: State<'_, IndexState>,
    path: PathBuf,
    content: Option<String>,
) -> Result<(), FileError> {
    let Some((s, rel)) = vault_store(&state, &path) else {
        return Ok(());
    };
    match (content, s.queued(&rel)) {
        (Some(c), Some(mut item)) => {
            item.content = c;
            s.enqueue(&item)?;
        }
        _ => s.dequeue(&rel),
    }
    Ok(())
}

#[tauri::command(async)]
fn queue_list(state: State<'_, IndexState>) -> Vec<QueueItem> {
    current_store(&state)
        .map(|s| s.queue_list())
        .unwrap_or_default()
}

#[tauri::command(async)]
fn annotations_get(state: State<'_, IndexState>, path: PathBuf) -> Vec<Annotation> {
    vault_store(&state, &path)
        .map(|(s, rel)| s.annotations(&rel))
        .unwrap_or_default()
}

#[tauri::command(async)]
fn annotations_save(
    state: State<'_, IndexState>,
    path: PathBuf,
    list: Vec<Annotation>,
) -> Result<(), FileError> {
    let Some((s, rel)) = vault_store(&state, &path) else {
        return Ok(());
    };
    Ok(s.save_annotations(&rel, &list)?)
}

#[tauri::command(async)]
fn agents_get(state: State<'_, IndexState>) -> Vec<AgentInfo> {
    current_store(&state)
        .map(|s| s.agents())
        .unwrap_or_default()
}

#[tauri::command(async)]
fn activity_get(state: State<'_, IndexState>, limit: usize) -> Vec<Activity> {
    current_store(&state)
        .map(|s| s.activity(limit))
        .unwrap_or_default()
}

#[tauri::command(async)]
fn vault_config_get(state: State<'_, IndexState>) -> VaultConfig {
    current_store(&state)
        .map(|s| s.config())
        .unwrap_or_default()
}

#[tauri::command(async)]
fn vault_config_set(state: State<'_, IndexState>, config: VaultConfig) -> Result<(), FileError> {
    match current_store(&state) {
        Some(s) => Ok(s.set_config(&config)?),
        None => Ok(()),
    }
}

/// 接入 MCP 用的命令：本程序加 `mcp --vault <库>`（设置 › MCP 里生成配置片段）
#[tauri::command]
fn mcp_command() -> String {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "zyrite".into())
}

/// 打开库时在后台建索引；root 为 None 时关闭索引
#[tauri::command]
async fn index_open(app: AppHandle, root: Option<PathBuf>) -> Result<(), FileError> {
    let Some(root) = root else {
        *lock(&app.state::<IndexState>().0) = None;
        return Ok(());
    };
    let built = blocking({
        let root = root.clone();
        move || Ok(Index::build(&root)?)
    })
    .await?;
    *lock(&app.state::<IndexState>().0) = Some(built);
    let _ = Store::new(&root).app_heartbeat(std::process::id());
    let _ = app.emit(INDEX_CHANGED, ());
    Ok(())
}

fn with_index<T: Default>(state: &IndexState, f: impl FnOnce(&Index) -> T) -> T {
    lock(&state.0).as_ref().map(f).unwrap_or_default()
}

/// 双链补全和解析用的笔记名单
#[tauri::command(async)]
fn note_names(state: State<'_, IndexState>) -> Vec<NoteName> {
    with_index(&state, Index::names)
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Backlinks {
    linked: Vec<Mention>,
    unlinked: Vec<Mention>,
}

/// 指向这个文件的链接和未链接提及
#[tauri::command(async)]
fn backlinks(state: State<'_, IndexState>, path: PathBuf) -> Backlinks {
    with_index(&state, |ix| match ix.rel_of(&path) {
        Some(rel) => Backlinks {
            linked: ix.backlinks(&rel),
            unlinked: ix.unlinked(&rel, zyrite_core::index::MENTION_LIMIT),
        },
        None => Backlinks::default(),
    })
}

/// 全文搜索
#[tauri::command]
async fn search(app: AppHandle, query: String, limit: usize) -> Result<SearchResult, FileError> {
    blocking(move || {
        Ok(with_index(&app.state::<IndexState>(), |ix| {
            ix.search(&query, limit)
        }))
    })
    .await
}

#[tauri::command(async)]
fn tags(state: State<'_, IndexState>) -> Vec<TagCount> {
    with_index(&state, Index::tags)
}

#[tauri::command(async)]
fn notes_with_tag(state: State<'_, IndexState>, tag: String) -> Vec<String> {
    with_index(&state, |ix| ix.notes_with_tag(&tag))
}

/// 系统要打开的文件（macOS 在 Finder 里双击、"打开方式"走系统事件，不在命令行参数里）。
/// 界面还没取过启动文件时先存在这里；取过之后改成发事件，让界面直接打开。
#[derive(Default)]
struct LaunchState {
    pending: Mutex<Option<PathBuf>>,
    ready: std::sync::atomic::AtomicBool,
}

/// 启动时要打开的文件：系统事件给的优先，其次是命令行参数（`zyrite 笔记.md`、Windows 和 Linux 的"打开方式"）
#[tauri::command]
fn launch_path(state: State<'_, LaunchState>) -> Option<String> {
    state.ready.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(p) = state.pending.lock().ok()?.take() {
        return Some(p.display().to_string());
    }
    let arg = std::env::args_os()
        .skip(1)
        .find(|a| !a.to_string_lossy().starts_with('-'))?;
    let path = PathBuf::from(arg);
    let abs = std::path::absolute(&path).unwrap_or(path);
    Some(abs.display().to_string())
}

/// 系统让 app 打开一个文件：界面已就绪就发事件，否则留给 launch_path
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn open_from_system(app: &AppHandle, path: PathBuf) {
    let Some(state) = app.try_state::<LaunchState>() else {
        return;
    };
    if state.ready.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = app.emit("zyrite://open-path", path.display().to_string());
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    } else if let Ok(mut p) = state.pending.lock() {
        *p = Some(path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 不放在 setup 里：macOS 冷启动时"打开文件"事件可能比 setup 先到
        .manage(LaunchState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?.join("recovery");
            app.manage(RecoveryStore::new(dir));
            app.manage(WatchState::default());
            app.manage(IndexState::default());
            app.manage(ai::AiState::default());
            access::start_heartbeat(app.handle());
            menu::install(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_file,
            open_file_as,
            save_file,
            session_load,
            session_save,
            list_documents,
            list_tree,
            is_dir,
            create_file,
            create_dir,
            rename_path,
            count_link_updates,
            trash_path,
            watch,
            index_open,
            review_get,
            baseline_set,
            queue_set,
            queue_list,
            annotations_get,
            annotations_save,
            agents_get,
            activity_get,
            vault_config_get,
            vault_config_set,
            mcp_command,
            menu::menu_localize,
            menu::set_locale,
            access::mcp_access_list,
            access::mcp_access_answer,
            access::mcp_grant_set,
            access::mcp_grant_revoke,
            ai::ai_key_set,
            ai::ai_key_has,
            ai::ai_key_delete,
            ai::ai_chat,
            ai::ai_cancel,
            ai::ai_models,
            ai::ai_index,
            ai::ai_retrieve,
            note_names,
            backlinks,
            search,
            tags,
            notes_with_tag,
            allow_asset_dirs,
            media::clipboard_image,
            media::image_write,
            media::image_copy,
            media::image_upload,
            media::read_base64,
            media::write_text,
            media::export_docx,
            media::print_window,
            pdf::export_pdf,
            media::theme_list,
            media::theme_import,
            media::theme_remove,
            media::theme_read,
            launch_path
        ])
        .build(tauri::generate_context!())
        .expect("error while building Zyrite")
        .run(|_app, _event| {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                // 一次只开一个文档，多选时取第一个
                if let Some(path) = urls.into_iter().find_map(|u| u.to_file_path().ok()) {
                    open_from_system(_app, path);
                }
            }
        });
}
