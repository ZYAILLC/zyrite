//! 内置 AI 的命令：key 存系统钥匙串，请求直接发给用户配置的服务商。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use zyrite_ai::oauth::{self, ChatgptSession, Pkce};
use zyrite_ai::{Kind, Message, Provider};
use zyrite_core::vectors::{self, Chunk, VectorStore};

use crate::{lock, IndexState};

const KEYRING_SERVICE: &str = "ai.z-y.zyrite";
/// 流式输出事件：{ id, delta } / { id, done, text } / { id, error }
const AI_EVENT: &str = "zyrite://ai";
/// 建向量索引的进度：{ done, total }
const AI_INDEX_EVENT: &str = "zyrite://ai-index";

#[derive(Default)]
pub struct AiState(Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>);

/// 正在进行的浏览器授权：再开一次或取消时通知它停下
#[derive(Default)]
pub struct OauthState(Mutex<Option<std::sync::Arc<tokio::sync::Notify>>>);

/// 等用户在浏览器里授权的最长时间
const OAUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
/// 钥匙串里：这台电脑的 ChatGPT host id、ChatGPT 给 Zyrite 分配的 client_id（退出登录后也保留，下次登录复用）
const CHATGPT_HOST_ID: &str = "chatgpt-host-id";
const CHATGPT_CLIENT_ID: &str = "chatgpt-client-id";

fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())
}

fn key_of(id: Option<&str>) -> Option<String> {
    entry(id?).ok()?.get_password().ok()
}

/// 保存 key（只写不读：界面拿不到已保存的 key）
#[tauri::command(async)]
pub fn ai_key_set(id: String, key: String) -> Result<(), String> {
    entry(&id)?.set_password(&key).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn ai_key_has(id: String) -> bool {
    key_of(Some(&id)).is_some()
}

#[tauri::command(async)]
pub fn ai_key_delete(id: String) -> Result<(), String> {
    // ChatGPT 登录：顺便撤销授权（失败也不要紧，用户可以在 ChatGPT 设置里断开）
    if let Some(session) =
        key_of(Some(&id)).and_then(|k| serde_json::from_str::<ChatgptSession>(&k).ok())
    {
        tauri::async_runtime::spawn(async move {
            let _ = oauth::chatgpt_revoke(&session).await;
        });
    }
    match entry(&id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn refresh_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// 发请求要带的密钥。ChatGPT 套餐存的是登录状态：快过期就先续期（同一时间只续一次），再交出 access token
async fn secret_for(provider: &Provider, key_id: Option<&str>) -> Result<Option<String>, String> {
    if provider.kind != Kind::Chatgpt {
        return Ok(key_of(key_id));
    }
    let not_signed_in = || {
        zyrite_i18n::tr(
            "Not signed in to ChatGPT. Sign in again in Settings › AI Models.",
            "还没有登录 ChatGPT，请到 设置 › AI 模型 重新登录。",
        )
        .to_string()
    };
    let id = key_id.ok_or_else(not_signed_in)?;
    let _guard = refresh_lock().lock().await;
    let raw = key_of(Some(id)).ok_or_else(not_signed_in)?;
    let session: ChatgptSession = serde_json::from_str(&raw).map_err(|_| not_signed_in())?;
    if !session.needs_refresh() {
        return Ok(Some(session.access_token));
    }
    let fresh = oauth::chatgpt_refresh(&session)
        .await
        .map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&fresh).map_err(|e| e.to_string())?;
    entry(id)?.set_password(&json).map_err(|e| e.to_string())?;
    Ok(Some(fresh.access_token))
}

/// 在浏览器里登录授权，结果存进钥匙串（key_id 下）：
/// - orcarouter / openrouter：换一个 API 密钥
/// - chatgpt：ChatGPT 套餐的登录状态
#[tauri::command]
pub async fn ai_oauth(app: AppHandle, provider: String, key_id: String) -> Result<(), String> {
    let cancel = std::sync::Arc::new(tokio::sync::Notify::new());
    if let Some(old) = lock(&app.state::<OauthState>().0).replace(cancel.clone()) {
        old.notify_one();
    }
    let flow = oauth_flow(&app, &provider, &key_id);
    let result = tokio::select! {
        r = tokio::time::timeout(OAUTH_TIMEOUT, flow) => r.unwrap_or_else(|_| Err(zyrite_i18n::tr(
            "Sign-in timed out. Try again.",
            "等待授权超时，请再试一次。",
        ).to_string())),
        _ = cancel.notified() => Err(zyrite_i18n::tr("Sign-in was cancelled.", "授权已取消。").to_string()),
    };
    let oauth_state = app.state::<OauthState>();
    let mut current = lock(&oauth_state.0);
    if current
        .as_ref()
        .is_some_and(|c| std::sync::Arc::ptr_eq(c, &cancel))
    {
        *current = None;
    }
    drop(current);
    result
}

/// 取消正在进行的浏览器授权
#[tauri::command]
pub fn ai_oauth_cancel(state: State<'_, OauthState>) {
    if let Some(c) = lock(&state.0).take() {
        c.notify_one();
    }
}

async fn oauth_flow(app: &AppHandle, provider: &str, key_id: &str) -> Result<(), String> {
    let err = |e: zyrite_ai::AiError| e.to_string();
    let (listener, port) = oauth::listen().await.map_err(err)?;
    let pkce = Pkce::new();
    let state = oauth::random_token();
    let open = |url: &str| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| e.to_string())
    };
    match provider {
        "orcarouter" | "openrouter" => {
            let flow = if provider == "orcarouter" {
                oauth::ORCAROUTER
            } else {
                oauth::OPENROUTER
            };
            let redirect = flow.redirect_uri(port);
            open(&flow.authorize_url(&redirect, &pkce, &state, "Zyrite"))?;
            let params = oauth::wait_callback(&listener).await.map_err(err)?;
            let code = oauth::check_callback(&params, &state).map_err(err)?;
            let key = flow.exchange(&code, &pkce.verifier).await.map_err(err)?;
            entry(key_id)?.set_password(&key).map_err(|e| e.to_string())
        }
        "chatgpt" => {
            let host_id = match key_of(Some(CHATGPT_HOST_ID)) {
                Some(h) => h,
                None => {
                    let h = oauth::random_token();
                    entry(CHATGPT_HOST_ID)?
                        .set_password(&h)
                        .map_err(|e| e.to_string())?;
                    h
                }
            };
            let known = key_of(Some(CHATGPT_CLIENT_ID));
            let nonce = oauth::random_token();
            let redirect = oauth::chatgpt_redirect_uri(port);
            open(&oauth::chatgpt_authorize_url(
                known.as_deref(),
                &host_id,
                &redirect,
                &pkce,
                &state,
                &nonce,
            ))?;
            let params = oauth::wait_callback(&listener).await.map_err(err)?;
            let code = oauth::check_callback(&params, &state).map_err(err)?;
            let client_id = oauth::chatgpt_client_id(&params, known.as_deref()).map_err(err)?;
            if known.as_deref() != Some(client_id.as_str()) {
                entry(CHATGPT_CLIENT_ID)?
                    .set_password(&client_id)
                    .map_err(|e| e.to_string())?;
            }
            let session =
                oauth::chatgpt_exchange(&client_id, &code, &pkce.verifier, &redirect, &nonce)
                    .await
                    .map_err(err)?;
            let json = serde_json::to_string(&session).map_err(|e| e.to_string())?;
            entry(key_id)?
                .set_password(&json)
                .map_err(|e| e.to_string())
        }
        _ => Err(zyrite_ai::AiError::Unsupported.to_string()),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiEvent {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    done: bool,
}

/// 开始一次流式对话；输出通过 zyrite://ai 事件推给界面
#[tauri::command]
pub fn ai_chat(
    app: AppHandle,
    state: State<'_, AiState>,
    id: String,
    provider: Provider,
    key_id: Option<String>,
    messages: Vec<Message>,
) {
    let emitter = app.clone();
    let task_id = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let ev = |delta: Option<String>,
                  text: Option<String>,
                  error: Option<String>,
                  done: bool| AiEvent {
            id: task_id.clone(),
            delta,
            text,
            error,
            done,
        };
        let result = match secret_for(&provider, key_id.as_deref()).await {
            Ok(key) => zyrite_ai::chat(&provider, key.as_deref(), &messages, |d| {
                let _ = emitter.emit(AI_EVENT, ev(Some(d.to_string()), None, None, false));
            })
            .await
            .map_err(|e| e.to_string()),
            Err(e) => Err(e),
        };
        let _ = match result {
            Ok(text) => emitter.emit(AI_EVENT, ev(None, Some(text), None, true)),
            Err(e) => emitter.emit(AI_EVENT, ev(None, None, Some(e), true)),
        };
        emitter
            .state::<AiState>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&task_id);
    });
    lock(&state.0).insert(id, handle);
}

/// 同步模型列表：向服务商要它提供的模型名
#[tauri::command]
pub async fn ai_models(provider: Provider, key_id: Option<String>) -> Result<Vec<String>, String> {
    let key = secret_for(&provider, key_id.as_deref()).await?;
    zyrite_ai::list_models(&provider, key.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AiState>, id: String) {
    if let Some(h) = lock(&state.0).remove(&id) {
        h.abort();
    }
}

fn all_chunks(state: &IndexState) -> (Option<PathBuf>, Vec<Chunk>) {
    let guard = lock(&state.0);
    let Some(ix) = guard.as_ref() else {
        return (None, Vec::new());
    };
    let chunks = ix
        .texts()
        .flat_map(|(rel, text)| vectors::chunk(rel, text))
        .collect();
    (Some(ix.root().to_path_buf()), chunks)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    chunks: usize,
    embedded: usize,
}

/// 给库建（或增量更新）向量索引；进度通过 zyrite://ai-index 推给界面
#[tauri::command]
pub async fn ai_index(
    app: AppHandle,
    provider: Provider,
    key_id: Option<String>,
) -> Result<IndexResult, String> {
    let (root, chunks) = all_chunks(&app.state::<IndexState>());
    let root = root.ok_or(zyrite_i18n::tr("No folder is open yet", "还没有打开文件夹"))?;
    let key = key_of(key_id.as_deref());
    let mut store = VectorStore::open(&root, &format!("{:?}:{}", provider.kind, provider.model));
    let missing: Vec<Chunk> = store.missing(&chunks).into_iter().cloned().collect();
    let total = missing.len();
    let mut fresh = HashMap::new();
    for (i, batch) in missing.chunks(32).enumerate() {
        let inputs: Vec<String> = batch
            .iter()
            .map(|c| format!("{}\n{}", c.heading, c.text))
            .collect();
        let vecs = zyrite_ai::embed(&provider, key.as_deref(), &inputs)
            .await
            .map_err(|e| e.to_string())?;
        for (c, v) in batch.iter().zip(vecs) {
            fresh.insert(vectors::hash(&c.text), v);
        }
        let _ = app.emit(
            AI_INDEX_EVENT,
            serde_json::json!({ "done": (i * 32 + batch.len()).min(total), "total": total }),
        );
    }
    store.rebuild(&chunks, &fresh).map_err(|e| e.to_string())?;
    Ok(IndexResult {
        chunks: store.len(),
        embedded: total,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    rel: String,
    line: usize,
    heading: String,
    text: String,
    score: f32,
}

/// 问答检索：有向量模型和向量索引时按向量找，否则按词找。scope 是文件夹前缀或文件的相对路径
#[tauri::command]
pub async fn ai_retrieve(
    app: AppHandle,
    question: String,
    scope: Option<String>,
    k: usize,
    embed: Option<Provider>,
    key_id: Option<String>,
) -> Result<Vec<Passage>, String> {
    let (root, chunks) = all_chunks(&app.state::<IndexState>());
    let Some(root) = root else {
        return Ok(Vec::new());
    };
    let in_scope = |c: &Chunk| {
        scope
            .as_deref()
            .is_none_or(|s| c.rel == s || c.rel.starts_with(s))
    };
    let chunks: Vec<Chunk> = chunks.into_iter().filter(in_scope).collect();
    if let Some(p) = embed {
        let store = VectorStore::open(&root, &format!("{:?}:{}", p.kind, p.model));
        if !store.is_empty() {
            let key = key_of(key_id.as_deref());
            let q = zyrite_ai::embed(&p, key.as_deref(), std::slice::from_ref(&question))
                .await
                .map_err(|e| e.to_string())?;
            let hits = store.search(&q[0], k, scope.as_deref());
            let by_pos: HashMap<(&str, usize), &Chunk> = chunks
                .iter()
                .map(|c| ((c.rel.as_str(), c.line), c))
                .collect();
            return Ok(hits
                .into_iter()
                .filter_map(|h| {
                    let text = by_pos.get(&(h.rel.as_str(), h.line))?.text.clone();
                    Some(Passage {
                        rel: h.rel,
                        line: h.line,
                        heading: h.heading,
                        text,
                        score: h.score,
                    })
                })
                .collect());
        }
    }
    Ok(vectors::lexical_search(&chunks, &question, k)
        .into_iter()
        .map(|(c, score)| Passage {
            rel: c.rel.clone(),
            line: c.line,
            heading: c.heading.clone(),
            text: c.text.clone(),
            score,
        })
        .collect())
}
