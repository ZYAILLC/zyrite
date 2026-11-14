//! 在浏览器里登录授权（OAuth 2.0 + PKCE，回调到本机 127.0.0.1 的随机端口）。
//!
//! 两种用法：
//! - 换 API 密钥：OrcaRouter、OpenRouter 的"免费连接"。授权后拿一次性 code 换一个普通 API 密钥。
//! - ChatGPT 套餐：OpenAI 的 Sign in with ChatGPT（开源、本地运行的应用可以直接用）。
//!   授权后拿到 access token（1 小时）和 refresh token（30 天，每次续期都换新），
//!   推理走 `https://api.openai.com/v1/responses`，用量算在用户的 ChatGPT 套餐里。
//!
//! 只负责协议本身；把结果存进系统钥匙串、打开浏览器由桌面端负责。

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::AiError;

/// 回调页面的路径
pub const CALLBACK_PATH: &str = "/auth/callback";

/// 32 字节随机数，base64url 编码（PKCE verifier、state、nonce 都用它）
pub fn random_token() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

/// PKCE：verifier 留在本地，challenge = base64url(SHA-256(verifier)) 放进授权地址
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn new() -> Self {
        let verifier = random_token();
        Self {
            challenge: challenge(&verifier),
            verifier,
        }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Self::new()
    }
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h << 4 | l);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query(params: &[(&str, &str)]) -> String {
    params
        .iter()
        .map(|(k, v)| format!("{k}={}", encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// 解析 `a=1&b=x%20y`
pub fn parse_query(q: &str) -> HashMap<String, String> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (decode(k), decode(v)),
            None => (decode(p), String::new()),
        })
        .collect()
}

/// 在 127.0.0.1 上开一个随机端口，等浏览器回调
pub async fn listen() -> Result<(TcpListener, u16), AiError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| AiError::Connect("127.0.0.1".into(), e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| AiError::Connect("127.0.0.1".into(), e.to_string()))?
        .port();
    Ok((listener, port))
}

fn page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">\
<title>Zyrite</title><style>body{{font:15px/1.6 -apple-system,system-ui,sans-serif;display:grid;place-items:center;\
min-height:90vh;margin:0 16px;color:#222;background:#f6f7f9}}@media(prefers-color-scheme:dark){{body{{color:#eee;background:#1c1d20}}}}\
main{{max-width:28em;text-align:center}}</style></head><body><main><h1>{title}</h1><p>{body}</p></main></body></html>"
    )
}

/// 等第一个打到回调路径的请求，回一个"可以回到 Zyrite 了"的页面，返回它的参数。
/// 其他路径（比如 /favicon.ico）回 404 后继续等。超时由调用方控制。
pub async fn wait_callback(listener: &TcpListener) -> Result<HashMap<String, String>, AiError> {
    loop {
        let (mut sock, _) = listener
            .accept()
            .await
            .map_err(|e| AiError::Connect("127.0.0.1".into(), e.to_string()))?;
        let mut buf = vec![0u8; 8192];
        let mut len = 0;
        // 只要请求行：读到第一个换行就够了
        while len < buf.len() {
            match sock.read(&mut buf[len..]).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    len += n;
                    if buf[..len].contains(&b'\n') {
                        break;
                    }
                }
            }
        }
        let head = String::from_utf8_lossy(&buf[..len]);
        let target = head
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("");
        let (path, q) = target.split_once('?').unwrap_or((target, ""));
        if path != CALLBACK_PATH && path != "/callback" {
            let _ = sock
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            continue;
        }
        let params = parse_query(q);
        let ok = params.contains_key("code");
        let html = if ok {
            page(
                zyrite_i18n::tr("You're signed in", "授权完成"),
                zyrite_i18n::tr(
                    "You can close this page and go back to Zyrite.",
                    "可以关掉这个页面，回到 Zyrite 了。",
                ),
            )
        } else {
            page(
                zyrite_i18n::tr("Sign-in didn't finish", "授权没有完成"),
                zyrite_i18n::tr("Go back to Zyrite and try again.", "回到 Zyrite 再试一次。"),
            )
        };
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
            html.len()
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        let _ = sock.shutdown().await;
        return Ok(params);
    }
}

/// 检查回调：state 要对得上，用户拒绝或出错时给出能看懂的错误
pub fn check_callback(params: &HashMap<String, String>, state: &str) -> Result<String, AiError> {
    if params.get("state").map(String::as_str) != Some(state) {
        return Err(AiError::Auth(
            zyrite_i18n::tr(
                "The sign-in response didn't match this request. Try again.",
                "授权返回的信息和这次请求对不上，请再试一次。",
            )
            .into(),
        ));
    }
    if let Some(err) = params.get("error") {
        if err == "access_denied" {
            return Err(AiError::Auth(
                zyrite_i18n::tr("Sign-in was cancelled.", "授权已取消。").into(),
            ));
        }
        let desc = params.get("error_description").cloned().unwrap_or_default();
        return Err(AiError::Auth(format!("{err} {desc}").trim().to_string()));
    }
    params.get("code").cloned().ok_or_else(|| {
        AiError::Auth(
            zyrite_i18n::tr(
                "The sign-in response had no authorization code.",
                "授权返回里没有授权码。",
            )
            .into(),
        )
    })
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

async fn json_of(target: &str, req: reqwest::RequestBuilder) -> Result<Value, AiError> {
    let resp = req
        .send()
        .await
        .map_err(|e| AiError::Connect(target.into(), e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AiError::Status {
            status: status.as_u16(),
            body: text.chars().take(500).collect(),
        });
    }
    serde_json::from_str(&text).map_err(|e| {
        AiError::Parse(format!(
            "{e}: {}",
            text.chars().take(300).collect::<String>()
        ))
    })
}

// ---------------------------------------------------------------------------
// 换 API 密钥（OrcaRouter、OpenRouter）
// ---------------------------------------------------------------------------

/// 用浏览器授权换 API 密钥的服务商
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyFlow {
    /// 授权页
    pub auth_url: &'static str,
    /// 用 code 换密钥的接口
    pub exchange_url: &'static str,
    /// 回调地址写 localhost 还是 127.0.0.1（OpenRouter 的文档写的是 localhost）
    pub localhost: bool,
}

pub const ORCAROUTER: KeyFlow = KeyFlow {
    auth_url: "https://www.orcarouter.ai/auth",
    exchange_url: "https://www.orcarouter.ai/api/v1/auth/keys",
    localhost: false,
};

pub const OPENROUTER: KeyFlow = KeyFlow {
    auth_url: "https://openrouter.ai/auth",
    exchange_url: "https://openrouter.ai/api/v1/auth/keys",
    localhost: true,
};

impl KeyFlow {
    pub fn redirect_uri(&self, port: u16) -> String {
        let host = if self.localhost {
            "localhost"
        } else {
            "127.0.0.1"
        };
        format!("http://{host}:{port}{CALLBACK_PATH}")
    }

    pub fn authorize_url(
        &self,
        redirect_uri: &str,
        pkce: &Pkce,
        state: &str,
        app_name: &str,
    ) -> String {
        format!(
            "{}?{}",
            self.auth_url,
            query(&[
                ("callback_url", redirect_uri),
                ("code_challenge", &pkce.challenge),
                ("code_challenge_method", "S256"),
                ("state", state),
                ("app_name", app_name),
            ])
        )
    }

    /// 用一次性 code 换 API 密钥
    pub async fn exchange(&self, code: &str, verifier: &str) -> Result<String, AiError> {
        let body = serde_json::json!({
            "code": code,
            "code_verifier": verifier,
            "code_challenge_method": "S256",
        });
        let v = json_of(
            self.exchange_url,
            client().post(self.exchange_url).json(&body),
        )
        .await?;
        v.get("key")
            .and_then(Value::as_str)
            .filter(|k| !k.is_empty())
            .map(str::to_string)
            .ok_or_else(|| AiError::Parse(v.to_string().chars().take(300).collect()))
    }
}

// ---------------------------------------------------------------------------
// ChatGPT 套餐（Sign in with ChatGPT）
// ---------------------------------------------------------------------------

pub const CHATGPT_AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
pub const CHATGPT_TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const CHATGPT_DISCOVERY: &str = "https://auth.openai.com/.well-known/openid-configuration";
pub const CHATGPT_RESOURCE: &str = "https://api.openai.com/v1";
/// 第一次授权用它，回调会带回给这个应用分配的 client_id
pub const CHATGPT_DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const CHATGPT_SCOPE: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// 用 ChatGPT 套餐必须拿到的权限
const CHATGPT_PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";

pub fn chatgpt_redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}{CALLBACK_PATH}")
}

/// ChatGPT 授权地址。client_id 是上次分配的（没有就用 dynamic_agent_client 注册一个）；
/// host_id 每台电脑一个，固定不变。
pub fn chatgpt_authorize_url(
    client_id: Option<&str>,
    host_id: &str,
    redirect_uri: &str,
    pkce: &Pkce,
    state: &str,
    nonce: &str,
) -> String {
    let mut params: Vec<(&str, &str)> =
        vec![("client_id", client_id.unwrap_or(CHATGPT_DYNAMIC_CLIENT))];
    if client_id.is_none() {
        params.push(("agent_name_hint", "Zyrite"));
    }
    params.extend([
        ("ext_agent_host_id", host_id),
        ("response_type", "code"),
        ("redirect_uri", redirect_uri),
        ("scope", CHATGPT_SCOPE),
        ("resource", CHATGPT_RESOURCE),
        ("state", state),
        ("nonce", nonce),
        ("code_challenge_method", "S256"),
        ("code_challenge", &pkce.challenge),
    ]);
    format!("{CHATGPT_AUTHORIZE}?{}", query(&params))
}

/// 回调里分配的 client_id：第一次授权必须有；重新授权时可以没有，有的话必须和发出去的一样
pub fn chatgpt_client_id(
    params: &HashMap<String, String>,
    sent: Option<&str>,
) -> Result<String, AiError> {
    match (params.get("client_id").filter(|c| !c.is_empty()), sent) {
        (Some(got), Some(sent)) if got != sent => Err(AiError::Auth(
            zyrite_i18n::tr(
                "ChatGPT returned a different app registration. Try again.",
                "ChatGPT 返回的应用登记和之前不一样，请再试一次。",
            )
            .into(),
        )),
        (Some(got), _) => Ok(got.clone()),
        (None, Some(sent)) => Ok(sent.to_string()),
        (None, None) => Err(AiError::Auth(
            zyrite_i18n::tr(
                "ChatGPT didn't register Zyrite. Try again.",
                "ChatGPT 没有完成 Zyrite 的登记，请再试一次。",
            )
            .into(),
        )),
    }
}

/// 存进钥匙串的 ChatGPT 登录状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatgptSession {
    pub client_id: String,
    pub access_token: String,
    pub refresh_token: String,
    /// access token 过期时间（Unix 秒）
    pub expires_at: u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl ChatgptSession {
    /// 还剩不到两分钟就该续期了
    pub fn needs_refresh(&self) -> bool {
        self.expires_at <= now() + 120
    }

    fn from_tokens(
        client_id: &str,
        v: &Value,
        old_refresh: Option<&str>,
        nonce: Option<&str>,
    ) -> Result<Self, AiError> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).filter(|x| !x.is_empty());
        let access = s("access_token")
            .ok_or_else(|| AiError::Parse(v.to_string().chars().take(300).collect()))?;
        if let Some(scope) = s("scope") {
            if !scope.split_whitespace().any(|x| x == CHATGPT_PLAN_SCOPE) {
                return Err(AiError::Auth(not_eligible()));
            }
        }
        if let (Some(nonce), Some(id)) = (nonce, s("id_token")) {
            if id_token_nonce(id).as_deref() != Some(nonce) {
                return Err(AiError::Auth(
                    zyrite_i18n::tr(
                        "The sign-in response didn't match this request. Try again.",
                        "授权返回的信息和这次请求对不上，请再试一次。",
                    )
                    .into(),
                ));
            }
        }
        let refresh = s("refresh_token")
            .or(old_refresh)
            .ok_or_else(|| AiError::Parse(v.to_string().chars().take(300).collect()))?;
        let expires_in = v.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
        Ok(Self {
            client_id: client_id.to_string(),
            access_token: access.to_string(),
            refresh_token: refresh.to_string(),
            expires_at: now() + expires_in,
        })
    }
}

fn not_eligible() -> String {
    zyrite_i18n::tr(
        "This ChatGPT account can't use its plan in other apps. Check your plan at chatgpt.com.",
        "这个 ChatGPT 账号的套餐不能在其他应用里使用，请到 chatgpt.com 查看你的套餐。",
    )
    .into()
}

/// 取 ID token（JWT）里的 nonce。token 是直接从 OpenAI 的 token 接口通过 HTTPS 拿到的，只核对 nonce
fn id_token_nonce(jwt: &str) -> Option<String> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("nonce").and_then(Value::as_str).map(str::to_string)
}

/// 用授权码换 token
pub async fn chatgpt_exchange(
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    nonce: &str,
) -> Result<ChatgptSession, AiError> {
    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
        ("resource", CHATGPT_RESOURCE),
    ];
    let v = json_of(CHATGPT_TOKEN, client().post(CHATGPT_TOKEN).form(&form)).await?;
    ChatgptSession::from_tokens(client_id, &v, None, Some(nonce))
}

/// 续期：refresh token 每次都会换新，调用方要把返回的新状态存回去
pub async fn chatgpt_refresh(s: &ChatgptSession) -> Result<ChatgptSession, AiError> {
    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", s.client_id.as_str()),
        ("refresh_token", s.refresh_token.as_str()),
        ("resource", CHATGPT_RESOURCE),
    ];
    match json_of(CHATGPT_TOKEN, client().post(CHATGPT_TOKEN).form(&form)).await {
        Ok(v) => ChatgptSession::from_tokens(&s.client_id, &v, Some(&s.refresh_token), None),
        Err(AiError::Status {
            status: 400 | 401,
            body,
        }) => Err(AiError::Auth(format!(
            "{} {}",
            zyrite_i18n::tr(
                "Your ChatGPT sign-in has expired. Sign in again in Settings › AI Models.",
                "ChatGPT 登录已过期，请到 设置 › AI 模型 重新登录。",
            ),
            body.chars().take(200).collect::<String>()
        ))),
        Err(e) => Err(e),
    }
}

/// 退出登录：撤销 refresh token。失败也不要紧，用户可以在 ChatGPT 设置里断开
pub async fn chatgpt_revoke(s: &ChatgptSession) -> Result<(), AiError> {
    let d = json_of(CHATGPT_DISCOVERY, client().get(CHATGPT_DISCOVERY)).await?;
    let endpoint = d
        .get("revocation_endpoint")
        .and_then(Value::as_str)
        .ok_or_else(|| AiError::Parse(d.to_string().chars().take(300).collect()))?
        .to_string();
    let form = [
        ("token", s.refresh_token.as_str()),
        ("token_type_hint", "refresh_token"),
        ("client_id", s.client_id.as_str()),
    ];
    let resp = client()
        .post(&endpoint)
        .form(&form)
        .send()
        .await
        .map_err(|e| AiError::Connect(endpoint.clone(), e.to_string()))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(AiError::Status {
            status: resp.status().as_u16(),
            body: String::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pkce_challenge_matches_rfc7636_example() {
        // RFC 7636 附录 B 的例子
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let p = Pkce::new();
        assert_eq!(p.verifier.len(), 43);
        assert_ne!(p.verifier, Pkce::new().verifier);
    }

    #[test]
    fn query_round_trip() {
        let q = query(&[
            ("callback_url", "http://127.0.0.1:5/auth/callback"),
            ("app_name", "Zyrite 纸砚"),
        ]);
        assert!(q.starts_with("callback_url=http%3A%2F%2F127.0.0.1%3A5%2Fauth%2Fcallback&"));
        let back = parse_query(&q);
        assert_eq!(back["app_name"], "Zyrite 纸砚");
        assert_eq!(parse_query("a=1+2&b=%E4%BD%A0")["a"], "1 2");
        assert_eq!(parse_query("b=%E4%BD%A0")["b"], "你");
        assert_eq!(parse_query("c=50%")["c"], "50%");
    }

    #[test]
    fn key_flow_urls() {
        let p = Pkce::new();
        let r = ORCAROUTER.redirect_uri(4321);
        assert_eq!(r, "http://127.0.0.1:4321/auth/callback");
        assert_eq!(
            OPENROUTER.redirect_uri(4321),
            "http://localhost:4321/auth/callback"
        );
        let u = ORCAROUTER.authorize_url(&r, &p, "st", "Zyrite");
        assert!(u.starts_with("https://www.orcarouter.ai/auth?callback_url="));
        assert!(u.contains("code_challenge_method=S256"));
        assert!(u.contains(&format!("code_challenge={}", p.challenge)));
    }

    #[test]
    fn chatgpt_url_registers_on_first_sign_in_only() {
        let p = Pkce::new();
        let r = chatgpt_redirect_uri(1455);
        let first = parse_query(
            chatgpt_authorize_url(None, "host", &r, &p, "s", "n")
                .split_once('?')
                .unwrap()
                .1,
        );
        assert_eq!(first["client_id"], "dynamic_agent_client");
        assert_eq!(first["agent_name_hint"], "Zyrite");
        assert_eq!(first["redirect_uri"], "http://127.0.0.1:1455/auth/callback");
        assert!(first["scope"].contains("chatgpt.tokens.use.direct"));
        assert_eq!(first["resource"], "https://api.openai.com/v1");
        let again = parse_query(
            chatgpt_authorize_url(Some("oaiapp_1"), "host", &r, &p, "s", "n")
                .split_once('?')
                .unwrap()
                .1,
        );
        assert_eq!(again["client_id"], "oaiapp_1");
        assert!(!again.contains_key("agent_name_hint"));
    }

    #[test]
    fn callback_checks() {
        let p = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<HashMap<_, _>>()
        };
        assert_eq!(
            check_callback(&p(&[("code", "c"), ("state", "s")]), "s").unwrap(),
            "c"
        );
        assert!(check_callback(&p(&[("code", "c"), ("state", "x")]), "s").is_err());
        assert!(check_callback(&p(&[("error", "access_denied"), ("state", "s")]), "s").is_err());
        assert_eq!(
            chatgpt_client_id(&p(&[("client_id", "oaiapp_1")]), None).unwrap(),
            "oaiapp_1"
        );
        assert_eq!(
            chatgpt_client_id(&p(&[]), Some("oaiapp_1")).unwrap(),
            "oaiapp_1"
        );
        assert!(chatgpt_client_id(&p(&[("client_id", "oaiapp_2")]), Some("oaiapp_1")).is_err());
        assert!(chatgpt_client_id(&p(&[]), None).is_err());
    }

    #[test]
    fn session_from_tokens() {
        let id = format!("h.{}.s", URL_SAFE_NO_PAD.encode(br#"{"nonce":"n1"}"#));
        let v = json!({
            "access_token": "at", "refresh_token": "rt", "id_token": id,
            "expires_in": 3600, "scope": "openid chatgpt.tokens.use.direct offline_access"
        });
        let s = ChatgptSession::from_tokens("oaiapp_1", &v, None, Some("n1")).unwrap();
        assert_eq!(
            (s.access_token.as_str(), s.refresh_token.as_str()),
            ("at", "rt")
        );
        assert!(!s.needs_refresh());
        assert!(ChatgptSession::from_tokens("oaiapp_1", &v, None, Some("other")).is_err());
        let no_plan = json!({ "access_token": "at", "refresh_token": "rt", "scope": "openid" });
        assert!(ChatgptSession::from_tokens("c", &no_plan, None, None).is_err());
        // 续期没给新的 refresh token 时沿用旧的
        let refreshed = ChatgptSession::from_tokens(
            "c",
            &json!({ "access_token": "a2", "expires_in": 0 }),
            Some("rt"),
            None,
        )
        .unwrap();
        assert_eq!(refreshed.refresh_token, "rt");
        assert!(refreshed.needs_refresh());
    }

    #[tokio::test]
    async fn callback_server_answers_and_returns_params() {
        let (listener, port) = listen().await.unwrap();
        let server = tokio::spawn(async move { wait_callback(&listener).await });
        let get = |path: &'static str| async move {
            let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
                .await
                .unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).await.unwrap();
            out
        };
        assert!(get("/favicon.ico").await.starts_with("HTTP/1.1 404"));
        assert!(get("/auth/callback?code=abc&state=s%201")
            .await
            .starts_with("HTTP/1.1 200"));
        let params = server.await.unwrap().unwrap();
        assert_eq!(params["code"], "abc");
        assert_eq!(params["state"], "s 1");
    }
}
