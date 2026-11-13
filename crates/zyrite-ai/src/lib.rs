//! Zyrite 内置 AI：直接调用用户配置的服务商，不经过任何 Zyrite 或 z-y.ai 的服务器。
//!
//! - OpenAI 兼容接口（DeepSeek、硅基流动、豆包、智谱、OpenAI……）：`{base}/chat/completions`（SSE 流式）、`{base}/embeddings`
//! - Ollama：`{base}/api/chat`（逐行 JSON 流式）、`{base}/api/embed`

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Openai,
    Ollama,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub kind: Kind,
    /// 例如 https://api.deepseek.com/v1、http://127.0.0.1:11434
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("连不上 {0}：{1}")]
    Connect(String, String),
    #[error("服务商返回错误（{status}）：{body}")]
    Status { status: u16, body: String },
    #[error("看不懂服务商的返回：{0}")]
    Parse(String),
}

impl Serialize for AiError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn url(p: &Provider, path: &str) -> String {
    format!(
        "{}/{}",
        p.base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default()
}

async fn post(
    p: &Provider,
    path: &str,
    key: Option<&str>,
    body: Value,
) -> Result<reqwest::Response, AiError> {
    let target = url(p, path);
    let mut req = client().post(&target).json(&body);
    if let Some(k) = key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(k);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| AiError::Connect(target.clone(), e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let body: String = body.chars().take(500).collect();
        return Err(AiError::Status {
            status: status.as_u16(),
            body,
        });
    }
    Ok(resp)
}

/// 流式对话：每收到一段就调用 on_delta，返回完整回答
pub async fn chat(
    p: &Provider,
    key: Option<&str>,
    messages: &[Message],
    mut on_delta: impl FnMut(&str),
) -> Result<String, AiError> {
    let (path, body) = match p.kind {
        Kind::Openai => (
            "chat/completions",
            json!({ "model": p.model, "messages": messages, "stream": true }),
        ),
        Kind::Ollama => (
            "api/chat",
            json!({ "model": p.model, "messages": messages, "stream": true }),
        ),
    };
    let resp = post(p, path, key, body).await?;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();
    let mut handle_line = |line: &str, full: &mut String| -> Result<bool, AiError> {
        let line = line.trim();
        if line.is_empty() {
            return Ok(false);
        }
        let data = match p.kind {
            Kind::Openai => match line.strip_prefix("data:") {
                Some(d) => d.trim(),
                None => return Ok(false), // event:、注释行
            },
            Kind::Ollama => line,
        };
        if data == "[DONE]" {
            return Ok(true);
        }
        let v: Value =
            serde_json::from_str(data).map_err(|e| AiError::Parse(format!("{e}: {data}")))?;
        if let Some(err) = v.get("error") {
            return Err(AiError::Status {
                status: 200,
                body: err.to_string(),
            });
        }
        let (delta, done) = match p.kind {
            Kind::Openai => (
                v.pointer("/choices/0/delta/content")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                false,
            ),
            Kind::Ollama => (
                v.pointer("/message/content")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                v.get("done").and_then(Value::as_bool).unwrap_or(false),
            ),
        };
        if !delta.is_empty() {
            full.push_str(delta);
            on_delta(delta);
        }
        Ok(done)
    };
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AiError::Connect(url(p, path), e.to_string()))?;
        buf.extend_from_slice(&chunk);
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            if handle_line(&String::from_utf8_lossy(&line), &mut full)? {
                return Ok(full);
            }
        }
    }
    if !buf.is_empty() {
        handle_line(&String::from_utf8_lossy(&buf), &mut full)?;
    }
    Ok(full)
}

/// 文字转向量（问答检索用），按输入顺序返回
pub async fn embed(
    p: &Provider,
    key: Option<&str>,
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, AiError> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let to_vec = |v: &Value| -> Vec<f32> {
        v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_f64)
                    .map(|x| x as f32)
                    .collect()
            })
            .unwrap_or_default()
    };
    let out = match p.kind {
        Kind::Openai => {
            let v: Value = post(
                p,
                "embeddings",
                key,
                json!({ "model": p.model, "input": inputs }),
            )
            .await?
            .json()
            .await
            .map_err(|e| AiError::Parse(e.to_string()))?;
            let mut items: Vec<(usize, Vec<f32>)> = v
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| AiError::Parse(v.to_string().chars().take(300).collect()))?
                .iter()
                .enumerate()
                .map(|(i, d)| {
                    (
                        d.get("index")
                            .and_then(Value::as_u64)
                            .map_or(i, |x| x as usize),
                        to_vec(&d["embedding"]),
                    )
                })
                .collect();
            items.sort_by_key(|x| x.0);
            items.into_iter().map(|x| x.1).collect::<Vec<_>>()
        }
        Kind::Ollama => {
            let v: Value = post(
                p,
                "api/embed",
                key,
                json!({ "model": p.model, "input": inputs }),
            )
            .await?
            .json()
            .await
            .map_err(|e| AiError::Parse(e.to_string()))?;
            v.get("embeddings")
                .and_then(Value::as_array)
                .ok_or_else(|| AiError::Parse(v.to_string().chars().take(300).collect()))?
                .iter()
                .map(to_vec)
                .collect()
        }
    };
    if out.len() != inputs.len() || out.iter().any(Vec::is_empty) {
        return Err(AiError::Parse(format!(
            "要 {} 个向量，收到 {} 个",
            inputs.len(),
            out.len()
        )));
    }
    Ok(out)
}
