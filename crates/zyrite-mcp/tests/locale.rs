//! MCP 的文案默认英文，切到中文后说明、工具描述、报错都换成中文。
//! 语言是进程级的全局设置，所以单独放在这个测试文件里（独立进程），只有一个测试。

use serde_json::{json, Value};
use zyrite_i18n::{set_locale, Locale};
use zyrite_mcp::Server;

fn initialize(root: &std::path::Path) -> Value {
    let msg = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "claude-code", "version": "2.0" }
    } });
    Server::new(root.to_path_buf()).handle(&msg).unwrap()
}

#[test]
fn 默认英文_可切换中文() {
    let dir = tempfile::tempdir().unwrap();

    let r = initialize(dir.path());
    assert!(
        r["result"]["instructions"]
            .as_str()
            .unwrap()
            .starts_with("Zyrite is a Markdown editor"),
        "{r}"
    );
    assert_eq!(
        Server::tools()[0]["description"],
        "List the notes in the vault: path, title, modified time."
    );

    set_locale(Locale::ZhCn);
    let r = initialize(dir.path());
    assert!(
        r["result"]["instructions"]
            .as_str()
            .unwrap()
            .starts_with("Zyrite 是一个 Markdown 编辑器"),
        "{r}"
    );
    assert_eq!(
        Server::tools()[0]["description"],
        "列出库里的笔记：路径、标题、修改时间。"
    );
    assert_eq!(zyrite_mcp::display_name(""), "MCP 客户端");

    set_locale(Locale::En);
    assert_eq!(zyrite_mcp::display_name(""), "MCP client");
}
