// Windows release 版不弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // `zyrite mcp [--vault <库>]`：给 Claude Code、Cursor、Codex 用的 MCP server，不启动界面
    if args.get(1).map(String::as_str) == Some("mcp") {
        if let Err(e) = zyrite_mcp::run_from_args(&args[2..]) {
            eprintln!("zyrite mcp: {e}");
            std::process::exit(1);
        }
        return;
    }
    zyrite_desktop_lib::run()
}
