//! Zyrite 内置 AI：直接调用用户配置的服务商，不经过任何 Zyrite 或 z-y.ai 的服务器。
//!
//! 按协议分（服务商目录在前端，每个服务商对应其中一种协议）：
//! - OpenAI 兼容（DeepSeek、通义千问、智谱、Kimi、豆包、OpenRouter、LM Studio……）：
//!   `{base}/chat/completions`（SSE 流式）、`{base}/models`、`{base}/embeddings`
//! - Anthropic Messages：`{base}/messages`（SSE 流式）、`{base}/models`
//! - Ollama：`{base}/api/chat`（逐行 JSON 流式）、`{base}/api/tags`、`{base}/api/embed`
//! - ChatGPT 套餐（在浏览器里用 ChatGPT 登录，见 [`oauth`]）：OpenAI Responses API，
//!   `{base}/responses`（SSE 流式，必须 store=false、stream=true）、`{base}/models`；不支持向量

pub mod oauth;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Openai,
    Anthropic,
    Ollama,
    /// ChatGPT 套餐：Responses API，key 是登录后拿到的 access token
    Chatgpt,
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
    #[error("{}", msg::connect(.0, .1))]
    Connect(String, String),
    #[error("{}", msg::status(*.status, .body))]
    Status { status: u16, body: String },
    #[error("{}", msg::parse(.0))]
    Parse(String),
    /// 这种协议不支持这个操作（例如 Anthropic、ChatGPT 套餐没有向量接口）
    #[error("{}", msg::unsupported())]
    Unsupported,
    /// 浏览器登录授权出错（已经是给用户看的文案）
    #[error("{0}")]
    Auth(String),
    /// 流在回答完成前就断了
    #[error("{}", msg::incomplete())]
    Incomplete,
}

/// 错误文案，按当前界面语言（见 zyrite-i18n）
mod msg {
    use zyrite_i18n::trf;

    pub fn connect(url: &str, e: &str) -> String {
        trf!("Can't connect to {url}: {e}", "连不上 {url}：{e}")
    }

    pub fn status(status: u16, body: &str) -> String {
        trf!(
            "The provider returned an error ({status}): {body}",
            "服务商返回错误（{status}）：{body}"
        )
    }

    pub fn parse(s: &str) -> String {
        trf!(
            "Couldn't understand the provider's response: {s}",
            "看不懂服务商的返回：{s}"
        )
    }

    pub fn unsupported() -> String {
        zyrite_i18n::tr(
            "This service doesn't support this feature",
            "这个服务不支持这项功能",
        )
        .to_string()
    }

    pub fn incomplete() -> String {
        zyrite_i18n::tr(
            "The answer was cut off before it finished. Try again.",
            "回答没有完成就中断了，请再试一次。",
        )
        .to_string()
    }
}

impl Serialize for AiError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Anthropic Messages API 要求的版本头
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Anthropic 必须给 max_tokens；改写用不了这么多，只是上限
const ANTHROPIC_MAX_TOKENS: u32 = 8192;

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

/// 按协议带上认证：Anthropic 用 x-api-key，其余用 Bearer；没有 key 就不带（本地模型）
fn authorize(
    kind: Kind,
    req: reqwest::RequestBuilder,
    key: Option<&str>,
) -> reqwest::RequestBuilder {
    let req = match kind {
        Kind::Anthropic => req.header("anthropic-version", ANTHROPIC_VERSION),
        _ => req,
    };
    match (kind, key.filter(|k| !k.is_empty())) {
        (Kind::Anthropic, Some(k)) => req.header("x-api-key", k),
        (_, Some(k)) => req.bearer_auth(k),
        (_, None) => req,
    }
}

async fn send(target: String, req: reqwest::RequestBuilder) -> Result<reqwest::Response, AiError> {
    let resp = req
        .send()
        .await
        .map_err(|e| AiError::Connect(target, e.to_string()))?;
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

async fn post(
    p: &Provider,
    path: &str,
    key: Option<&str>,
    body: Value,
) -> Result<reqwest::Response, AiError> {
    let target = url(p, path);
    let req = authorize(p.kind, client().post(&target).json(&body), key);
    send(target, req).await
}

async fn get(p: &Provider, path: &str, key: Option<&str>) -> Result<Value, AiError> {
    let target = url(p, path);
    let req = authorize(p.kind, client().get(&target), key);
    send(target, req)
        .await?
        .json()
        .await
        .map_err(|e| AiError::Parse(e.to_string()))
}

/// 对话请求：路径和请求体
fn chat_request(p: &Provider, messages: &[Message]) -> Result<(&'static str, Value), AiError> {
    Ok(match p.kind {
        Kind::Openai => (
            "chat/completions",
            json!({ "model": p.model, "messages": messages, "stream": true }),
        ),
        Kind::Ollama => (
            "api/chat",
            json!({ "model": p.model, "messages": messages, "stream": true }),
        ),
        Kind::Anthropic => {
            // system 不放在 messages 里，单独一个字段
            let system: Vec<&str> = messages
                .iter()
                .filter(|m| m.role == "system")
                .map(|m| m.content.as_str())
                .collect();
            let rest: Vec<&Message> = messages.iter().filter(|m| m.role != "system").collect();
            let mut body = json!({
                "model": p.model,
                "max_tokens": ANTHROPIC_MAX_TOKENS,
                "messages": rest,
                "stream": true,
            });
            if !system.is_empty() {
                body["system"] = Value::String(system.join("\n\n"));
            }
            ("messages", body)
        }
        Kind::Chatgpt => {
            // Responses API：system 放 instructions，其余放 input
            let system: Vec<&str> = messages
                .iter()
                .filter(|m| m.role == "system")
                .map(|m| m.content.as_str())
                .collect();
            let input: Vec<&Message> = messages.iter().filter(|m| m.role != "system").collect();
            let mut body = json!({
                "model": p.model,
                "input": input,
                "store": false,
                "stream": true,
            });
            if !system.is_empty() {
                body["instructions"] = Value::String(system.join("\n\n"));
            }
            ("responses", body)
        }
    })
}

/// 流里的一行解析出来的结果
#[derive(Debug, PartialEq)]
enum Line {
    /// 空行、event: 行、心跳等
    Skip,
    Delta(String),
    Done,
}

fn parse_line(kind: Kind, line: &str) -> Result<Line, AiError> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(Line::Skip);
    }
    let data = match kind {
        Kind::Ollama => line,
        _ => match line.strip_prefix("data:") {
            Some(d) => d.trim(),
            None => return Ok(Line::Skip), // event:、注释行
        },
    };
    if data == "[DONE]" {
        return Ok(Line::Done);
    }
    let v: Value =
        serde_json::from_str(data).map_err(|e| AiError::Parse(format!("{e}: {data}")))?;
    if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
        return Err(AiError::Status {
            status: 200,
            body: err.to_string(),
        });
    }
    if kind == Kind::Chatgpt && v.get("type").and_then(Value::as_str) == Some("error") {
        return Err(AiError::Status {
            status: 200,
            body: v.to_string().chars().take(500).collect(),
        });
    }
    let text = |ptr: &str| {
        v.pointer(ptr)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let delta = match kind {
        Kind::Openai => text("/choices/0/delta/content"),
        Kind::Chatgpt => match v.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") => text("/delta"),
            Some("response.completed" | "response.incomplete") => return Ok(Line::Done),
            Some("response.failed") => {
                return Err(AiError::Status {
                    status: 200,
                    body: v
                        .pointer("/response/error")
                        .map_or_else(|| v.to_string(), Value::to_string),
                })
            }
            _ => String::new(),
        },
        Kind::Ollama => {
            let d = text("/message/content");
            if v.get("done").and_then(Value::as_bool).unwrap_or(false) {
                return Ok(if d.is_empty() {
                    Line::Done
                } else {
                    // 最后一条也可能带内容：先交出内容，流结束时自然收尾
                    Line::Delta(d)
                });
            }
            d
        }
        Kind::Anthropic => match v.get("type").and_then(Value::as_str) {
            Some("content_block_delta") => text("/delta/text"),
            Some("message_stop") => return Ok(Line::Done),
            _ => String::new(),
        },
    };
    Ok(if delta.is_empty() {
        Line::Skip
    } else {
        Line::Delta(delta)
    })
}

/// 流式对话：每收到一段就调用 on_delta，返回完整回答
pub async fn chat(
    p: &Provider,
    key: Option<&str>,
    messages: &[Message],
    mut on_delta: impl FnMut(&str),
) -> Result<String, AiError> {
    let (path, body) = chat_request(p, messages)?;
    let resp = post(p, path, key, body).await?;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();
    let mut handle = |line: &str, full: &mut String| -> Result<bool, AiError> {
        match parse_line(p.kind, line)? {
            Line::Skip => Ok(false),
            Line::Done => Ok(true),
            Line::Delta(d) => {
                full.push_str(&d);
                on_delta(&d);
                Ok(false)
            }
        }
    };
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AiError::Connect(url(p, path), e.to_string()))?;
        buf.extend_from_slice(&chunk);
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            if handle(&String::from_utf8_lossy(&line), &mut full)? {
                return Ok(full);
            }
        }
    }
    if !buf.is_empty() && handle(&String::from_utf8_lossy(&buf), &mut full)? {
        return Ok(full);
    }
    // Responses API 一定以 response.completed 收尾，没收到就是中途断了
    if p.kind == Kind::Chatgpt {
        return Err(AiError::Incomplete);
    }
    Ok(full)
}

/// 从模型列表接口的返回里取模型名，去重、排序
fn parse_models(kind: Kind, v: &Value) -> Result<Vec<String>, AiError> {
    let (list, field) = match kind {
        Kind::Ollama => (v.get("models"), "name"),
        // ChatGPT 套餐：{ models: [{ slug, visibility }] }，只要 visibility == "list" 的
        Kind::Chatgpt => (v.get("models"), "slug"),
        _ => (v.get("data"), "id"),
    };
    let list = list
        .and_then(Value::as_array)
        .ok_or_else(|| AiError::Parse(v.to_string().chars().take(300).collect()))?;
    let mut names: Vec<String> = list
        .iter()
        .filter(|m| {
            kind != Kind::Chatgpt || m.get("visibility").and_then(Value::as_str) == Some("list")
        })
        .filter_map(|m| m.get(field).and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

/// 服务商提供的模型列表（"同步模型列表"）
pub async fn list_models(p: &Provider, key: Option<&str>) -> Result<Vec<String>, AiError> {
    let path = match p.kind {
        Kind::Openai | Kind::Anthropic | Kind::Chatgpt => "models",
        Kind::Ollama => "api/tags",
    };
    parse_models(p.kind, &get(p, path, key).await?)
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
        Kind::Anthropic | Kind::Chatgpt => return Err(AiError::Unsupported),
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
        return Err(AiError::Parse(zyrite_i18n::trf!(
            "Expected {} embeddings, got {}",
            "要 {} 个向量，收到 {} 个",
            inputs.len(),
            out.len()
        )));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(kind: Kind) -> Provider {
        Provider {
            kind,
            base_url: "https://example.com/v1/".into(),
            model: "m".into(),
        }
    }

    fn msg(role: &str, content: &str) -> Message {
        Message {
            role: role.into(),
            content: content.into(),
        }
    }

    #[test]
    fn anthropic_moves_system_out_of_messages() {
        let (path, body) = chat_request(
            &provider(Kind::Anthropic),
            &[msg("system", "be brief"), msg("user", "hi")],
        )
        .unwrap();
        assert_eq!(path, "messages");
        assert_eq!(body["system"], "be brief");
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], "user");
        assert!(body["max_tokens"].as_u64().unwrap() > 0);
    }

    #[test]
    fn openai_and_ollama_keep_messages() {
        let m = [msg("system", "s"), msg("user", "u")];
        let (path, body) = chat_request(&provider(Kind::Openai), &m).unwrap();
        assert_eq!(path, "chat/completions");
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        let (path, _) = chat_request(&provider(Kind::Ollama), &m).unwrap();
        assert_eq!(path, "api/chat");
    }

    #[test]
    fn chatgpt_uses_responses_api() {
        let (path, body) = chat_request(
            &provider(Kind::Chatgpt),
            &[msg("system", "be brief"), msg("user", "hi")],
        )
        .unwrap();
        assert_eq!(path, "responses");
        assert_eq!(body["instructions"], "be brief");
        assert_eq!(body["input"][0]["role"], "user");
        assert_eq!(body["input"].as_array().unwrap().len(), 1);
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn parses_chatgpt_stream() {
        let k = Kind::Chatgpt;
        assert_eq!(
            parse_line(k, "event: response.output_text.delta").unwrap(),
            Line::Skip
        );
        assert_eq!(
            parse_line(
                k,
                r#"data: {"type":"response.created","response":{"error":null}}"#
            )
            .unwrap(),
            Line::Skip
        );
        assert_eq!(
            parse_line(
                k,
                r#"data: {"type":"response.output_text.delta","delta":"你好"}"#
            )
            .unwrap(),
            Line::Delta("你好".into())
        );
        assert_eq!(
            parse_line(k, r#"data: {"type":"response.completed","response":{}}"#).unwrap(),
            Line::Done
        );
        assert!(parse_line(
            k,
            r#"data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}"#
        )
        .is_err());
        assert!(parse_line(k, r#"data: {"type":"error","code":"x","message":"y"}"#).is_err());
    }

    #[test]
    fn parses_openai_stream() {
        let k = Kind::Openai;
        assert_eq!(parse_line(k, "").unwrap(), Line::Skip);
        assert_eq!(parse_line(k, ": keep-alive").unwrap(), Line::Skip);
        assert_eq!(
            parse_line(k, r#"data: {"choices":[{"delta":{"content":"Hi"}}]}"#).unwrap(),
            Line::Delta("Hi".into())
        );
        assert_eq!(parse_line(k, "data: [DONE]").unwrap(), Line::Done);
        assert!(parse_line(k, r#"data: {"error":{"message":"bad key"}}"#).is_err());
    }

    #[test]
    fn parses_anthropic_stream() {
        let k = Kind::Anthropic;
        assert_eq!(
            parse_line(k, "event: content_block_delta").unwrap(),
            Line::Skip
        );
        assert_eq!(
            parse_line(
                k,
                r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}"#
            )
            .unwrap(),
            Line::Delta("你好".into())
        );
        assert_eq!(
            parse_line(k, r#"data: {"type":"message_start","message":{}}"#).unwrap(),
            Line::Skip
        );
        assert_eq!(
            parse_line(k, r#"data: {"type":"message_stop"}"#).unwrap(),
            Line::Done
        );
        assert!(parse_line(
            k,
            r#"data: {"type":"error","error":{"type":"overloaded_error"}}"#
        )
        .is_err());
    }

    #[test]
    fn parses_ollama_stream() {
        let k = Kind::Ollama;
        assert_eq!(
            parse_line(k, r#"{"message":{"content":"a"},"done":false}"#).unwrap(),
            Line::Delta("a".into())
        );
        assert_eq!(
            parse_line(k, r#"{"message":{"content":""},"done":true}"#).unwrap(),
            Line::Done
        );
    }

    #[test]
    fn parses_model_lists() {
        let openai = json!({ "data": [{ "id": "b" }, { "id": "a" }, { "id": "a" }] });
        assert_eq!(parse_models(Kind::Openai, &openai).unwrap(), ["a", "b"]);
        let ollama = json!({ "models": [{ "name": "qwen3:8b" }] });
        assert_eq!(parse_models(Kind::Ollama, &ollama).unwrap(), ["qwen3:8b"]);
        assert!(parse_models(Kind::Anthropic, &json!({ "oops": 1 })).is_err());
        let chatgpt = json!({ "models": [
            { "slug": "gpt-b", "visibility": "list" },
            { "slug": "hidden", "visibility": "hide" },
            { "slug": "gpt-a", "visibility": "list" }
        ] });
        assert_eq!(
            parse_models(Kind::Chatgpt, &chatgpt).unwrap(),
            ["gpt-a", "gpt-b"]
        );
    }

    #[test]
    fn joins_base_url_and_path() {
        assert_eq!(
            url(&provider(Kind::Openai), "/models"),
            "https://example.com/v1/models"
        );
    }
}
