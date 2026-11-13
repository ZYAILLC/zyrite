//! 用本地的假服务商检查协议：OpenAI 兼容接口的 SSE、Ollama 的逐行 JSON、两种向量接口、错误状态码

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::thread;

use zyrite_ai::{chat, embed, Kind, Message, Provider};

/// 起一个只回一次请求的 HTTP 服务；返回地址和"收到的请求"
fn serve_once(
    status: &str,
    content_type: &str,
    chunks: Vec<String>,
) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = format!("http://{}", listener.local_addr().unwrap());
    let status = status.to_string();
    let content_type = content_type.to_string();
    let handle = thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(sock.try_clone().unwrap());
        let mut head = String::new();
        let mut len = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if let Some(v) = line.to_lowercase().strip_prefix("content-length:") {
                len = v.trim().parse().unwrap();
            }
            head.push_str(&line);
            if line == "\r\n" {
                break;
            }
        }
        let mut body = vec![0; len];
        reader.read_exact(&mut body).unwrap();
        write!(sock, "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
        for c in chunks {
            // 故意把一行拆在两个 HTTP 分块里，检查缓冲拼接
            write!(sock, "{:x}\r\n{c}\r\n", c.len()).unwrap();
            sock.flush().unwrap();
        }
        write!(sock, "0\r\n\r\n").unwrap();
        format!("{head}{}", String::from_utf8_lossy(&body))
    });
    (addr, handle)
}

fn msgs() -> Vec<Message> {
    vec![Message {
        role: "user".into(),
        content: "你好".into(),
    }]
}

#[tokio::test]
async fn openai_兼容接口_流式() {
    let (addr, h) = serve_once(
        "200 OK",
        "text/event-stream",
        vec![
            ": keep-alive\n\n".into(),
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\ndata: {\"choices\":[{\"del".into(),
            "ta\":{\"content\":\"你\"}}]}\n\n".into(),
            "data: {\"choices\":[{\"delta\":{\"content\":\"好！\"}}]}\n\ndata: [DONE]\n\n".into(),
        ],
    );
    let p = Provider {
        kind: Kind::Openai,
        base_url: format!("{addr}/v1/"),
        model: "deepseek-chat".into(),
    };
    let mut deltas = Vec::new();
    let full = chat(&p, Some("sk-test"), &msgs(), |d| deltas.push(d.to_string()))
        .await
        .unwrap();
    assert_eq!(full, "你好！");
    assert_eq!(deltas, vec!["你", "好！"]);
    let req = h.join().unwrap();
    assert!(req.starts_with("POST /v1/chat/completions"), "{req}");
    assert!(req.to_lowercase().contains("authorization: bearer sk-test"));
    assert!(req.contains("\"stream\":true") && req.contains("deepseek-chat"));
}

#[tokio::test]
async fn ollama_流式() {
    let (addr, h) = serve_once(
        "200 OK",
        "application/x-ndjson",
        vec![
            "{\"message\":{\"role\":\"assistant\",\"content\":\"本地\"},\"done\":false}\n{\"message\":{\"content\":\"模".into(),
            "型\"},\"done\":false}\n{\"message\":{\"content\":\"\"},\"done\":true}\n".into(),
        ],
    );
    let p = Provider {
        kind: Kind::Ollama,
        base_url: addr,
        model: "qwen3:8b".into(),
    };
    let full = chat(&p, None, &msgs(), |_| {}).await.unwrap();
    assert_eq!(full, "本地模型");
    let req = h.join().unwrap();
    assert!(req.starts_with("POST /api/chat"));
    assert!(!req.to_lowercase().contains("authorization"));
}

#[tokio::test]
async fn 向量接口() {
    let (addr, _h) = serve_once(
        "200 OK",
        "application/json",
        vec!["{\"data\":[{\"index\":1,\"embedding\":[0.0,1.0]},{\"index\":0,\"embedding\":[1.0,0.0]}]}".into()],
    );
    let p = Provider {
        kind: Kind::Openai,
        base_url: addr,
        model: "BAAI/bge-m3".into(),
    };
    let v = embed(&p, Some("k"), &["a".into(), "b".into()])
        .await
        .unwrap();
    assert_eq!(v, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);

    let (addr, h) = serve_once(
        "200 OK",
        "application/json",
        vec!["{\"embeddings\":[[0.5,0.5]]}".into()],
    );
    let p = Provider {
        kind: Kind::Ollama,
        base_url: addr,
        model: "bge-m3".into(),
    };
    assert_eq!(
        embed(&p, None, &["x".into()]).await.unwrap(),
        vec![vec![0.5, 0.5]]
    );
    assert!(h.join().unwrap().starts_with("POST /api/embed"));
}

#[tokio::test]
async fn 错误() {
    let (addr, _h) = serve_once(
        "401 Unauthorized",
        "application/json",
        vec!["{\"error\":\"invalid key\"}".into()],
    );
    let p = Provider {
        kind: Kind::Openai,
        base_url: addr,
        model: "m".into(),
    };
    let e = chat(&p, Some("bad"), &msgs(), |_| {})
        .await
        .unwrap_err()
        .to_string();
    assert!(e.contains("401") && e.contains("invalid key"), "{e}");
    let p = Provider {
        kind: Kind::Openai,
        base_url: "http://127.0.0.1:9".into(),
        model: "m".into(),
    };
    assert!(chat(&p, None, &msgs(), |_| {})
        .await
        .unwrap_err()
        .to_string()
        .contains("连不上"));
}
