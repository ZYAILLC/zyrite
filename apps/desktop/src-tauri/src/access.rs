//! MCP 接入授权的应用端：列出授权和等待处理的请求、回答请求、改权限、撤销。
//! 签名密钥只在用户第一次点"允许"时创建；之后从钥匙串读一次就缓存在内存里。

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use zyrite_core::files::FileError;
use zyrite_core::grants::{self, AccessRequest, Grant};
use zyrite_core::store::{new_id, now_ms, Store};

use crate::{current_store, lock, IndexState};

static KEY: Mutex<Option<Vec<u8>>> = Mutex::new(None);

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(grants::KEY_SERVICE, grants::KEY_ACCOUNT).map_err(|e| e.to_string())
}

/// 签名密钥；create 为 true 时钥匙串里没有就新建一个
fn grant_key(create: bool) -> Result<Option<Vec<u8>>, String> {
    let mut cached = lock(&KEY);
    if cached.is_some() {
        return Ok(cached.clone());
    }
    let e = entry()?;
    let key = match e.get_password() {
        Ok(s) => grants::decode_key(&s),
        Err(keyring::Error::NoEntry) => None,
        Err(err) => return Err(err.to_string()),
    };
    let key = match key {
        Some(k) => Some(k),
        None if create => {
            let s = grants::new_key();
            e.set_password(&s).map_err(|err| err.to_string())?;
            grants::decode_key(&s)
        }
        None => None,
    };
    cached.clone_from(&key);
    Ok(key)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantView {
    #[serde(flatten)]
    grant: Grant,
    /// 签名有效（被改过、或者是从别的库复制来的就是无效的）
    valid: bool,
    /// 最近一次访问（从活动记录里按名字找）
    last_access_ms: Option<u64>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessList {
    grants: Vec<GrantView>,
    requests: Vec<AccessRequest>,
}

fn err(e: impl ToString) -> FileError {
    FileError::Io(std::io::Error::other(e.to_string()))
}

#[tauri::command(async)]
pub fn mcp_access_list(state: State<'_, IndexState>) -> AccessList {
    let Some(s) = current_store(&state) else {
        return AccessList::default();
    };
    let list = s.grants();
    // 没有授权时不碰钥匙串（免得一打开库就弹钥匙串的提示）
    let key = if list.is_empty() { None } else { grant_key(false).ok().flatten() };
    let activity = s.activity(500);
    let grants = list
        .into_iter()
        .map(|g| GrantView {
            valid: key.as_deref().is_some_and(|k| grants::verify(k, s.root(), &g)),
            last_access_ms: activity.iter().filter(|a| a.agent == g.name).map(|a| a.at_ms).max(),
            grant: g,
        })
        .collect();
    AccessList { grants, requests: s.requests() }
}

fn store(state: &IndexState) -> Result<Store, FileError> {
    current_store(state).ok_or_else(|| err("没有打开笔记库"))
}

/// 回答授权请求：允许时写一条"读 + 提交写入"的授权，拒绝时把请求标成 denied
#[tauri::command(async)]
pub fn mcp_access_answer(state: State<'_, IndexState>, id: String, allow: bool) -> Result<(), FileError> {
    let s = store(&state)?;
    let Some(mut req) = s.request(&id) else {
        return Ok(()); // Agent 已经不等了
    };
    if !allow {
        req.denied = true;
        return Ok(s.put_request(&req)?);
    }
    let key = grant_key(true).map_err(err)?.ok_or_else(|| err("无法创建签名密钥"))?;
    let mut list = s.grants();
    list.retain(|g| !(g.name == req.name && grants::same_program(&g.exe, &req.exe)));
    let mut g = Grant {
        id: new_id("g"),
        name: req.name.clone(),
        exe: req.exe.clone(),
        write: true,
        direct_write: false,
        created_ms: now_ms(),
        sig: String::new(),
    };
    grants::sign(&key, s.root(), &mut g);
    list.push(g);
    s.save_grants(&list)?;
    s.remove_request(&id);
    Ok(())
}

/// 改一条授权的权限（重新签名）
#[tauri::command(async)]
pub fn mcp_grant_set(
    state: State<'_, IndexState>,
    id: String,
    write: bool,
    direct_write: bool,
) -> Result<(), FileError> {
    let s = store(&state)?;
    let key = grant_key(true).map_err(err)?.ok_or_else(|| err("无法创建签名密钥"))?;
    let mut list = s.grants();
    let Some(g) = list.iter_mut().find(|g| g.id == id) else {
        return Ok(());
    };
    g.write = write;
    g.direct_write = direct_write && write;
    grants::sign(&key, s.root(), g);
    Ok(s.save_grants(&list)?)
}

#[tauri::command(async)]
pub fn mcp_grant_revoke(state: State<'_, IndexState>, id: String) -> Result<(), FileError> {
    let s = store(&state)?;
    let mut list = s.grants();
    list.retain(|g| g.id != id);
    Ok(s.save_grants(&list)?)
}

/// 应用开着库时每 15 秒写一次心跳：`zyrite mcp` 据此判断能不能弹窗问用户
pub fn start_heartbeat(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        if let Some(s) = current_store(&app.state::<IndexState>()) {
            let _ = s.app_heartbeat(std::process::id());
        }
        std::thread::sleep(Duration::from_secs(15));
    });
}
