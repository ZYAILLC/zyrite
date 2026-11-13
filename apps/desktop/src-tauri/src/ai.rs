//! 内置 AI 的命令：key 存系统钥匙串，请求直接发给用户配置的服务商。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use zyrite_ai::{Message, Provider};
use zyrite_core::vectors::{self, Chunk, VectorStore};

use crate::{lock, IndexState};

const KEYRING_SERVICE: &str = "ai.z-y.zyrite";
/// 流式输出事件：{ id, delta } / { id, done, text } / { id, error }
const AI_EVENT: &str = "zyrite://ai";
/// 建向量索引的进度：{ done, total }
const AI_INDEX_EVENT: &str = "zyrite://ai-index";

#[derive(Default)]
pub struct AiState(Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>);

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
    match entry(&id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
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
        let key = key_of(key_id.as_deref());
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
        let result = zyrite_ai::chat(&provider, key.as_deref(), &messages, |d| {
            let _ = emitter.emit(AI_EVENT, ev(Some(d.to_string()), None, None, false));
        })
        .await;
        let _ = match result {
            Ok(text) => emitter.emit(AI_EVENT, ev(None, Some(text), None, true)),
            Err(e) => emitter.emit(AI_EVENT, ev(None, None, Some(e.to_string()), true)),
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
    let root = root.ok_or("还没有打开文件夹")?;
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
