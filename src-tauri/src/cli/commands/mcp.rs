//! `jishu-cli mcp` 子命令（v0.9.0 需求1 P2）：聚合 server 与四家注入管理。

use crate::agent::mcp_inject::{self, SyncReport};
use crate::cli::args::McpAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: McpAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        McpAction::Serve => serve(),
        McpAction::Inject => {
            // 显式命令 = 显式意图：无条件注入（启动/插件启停的自动同步才是
            // 「MCP 解析器启用才注入」的条件语义，二期门控反转）。
            let report = mcp_inject::force_inject_all();
            print_report(&report, ctx);
            Ok(())
        }
        McpAction::Remove => {
            // remove：无条件回收自家条目（同名保护仍然生效）。
            let report = mcp_inject::remove_all_entries();
            print_report(&report, ctx);
            Ok(())
        }
        McpAction::Status => {
            status(ctx);
            Ok(())
        }
    }
}

fn serve() -> Result<(), CliError> {
    // stdio server：stdout 是协议通道，一切日志走 stderr。
    crate::agent::mcp_server::serve()
        .map_err(|e| CliError::Internal(e))
}

fn print_report(report: &SyncReport, _ctx: &ExecutionContext) {
    println!(
        "claude-code: {}\ncodex: {}\nopencode: {}\njishu-self: {}",
        report.claude_code, report.codex, report.opencode, report.jishu_self
    );
}

fn status(_ctx: &ExecutionContext) {
    // v0.9.0 需求1 二期：解析器启用态（注入门控）+ 分传输插件清单——
    // 即 mcp-resolver 系统插件 [panel] 的展示内容。
    let resolver_on = crate::agent::plugin::is_mcp_resolver_enabled();
    println!(
        "mcp-resolver: {}",
        if resolver_on { "enabled" } else { "disabled" }
    );
    let decls = crate::agent::mcp_server::load_mcp_plugin_decls();
    if decls.is_empty() {
        println!("MCP plugins: (none enabled)");
    } else {
        println!("MCP plugins ({}):", decls.len());
        use crate::agent::mcp_server::McpPluginDecl;
        for d in &decls {
            match d {
                McpPluginDecl::Stdio {
                    plugin_id,
                    command,
                    args,
                    ..
                } => println!("  {plugin_id} -> stdio: {command} {}", args.join(" ")),
                McpPluginDecl::Http { plugin_id, url, .. } => {
                    println!("  {plugin_id} -> http: {url}")
                }
                McpPluginDecl::Sse { plugin_id, url, .. } => {
                    println!("  {plugin_id} -> sse: {url}")
                }
            }
        }
    }
    println!(
        "cli binary: {}",
        mcp_inject::resolve_cli_path().unwrap_or_else(|e| format!("<unresolved: {e}>"))
    );
    if resolver_on {
        println!("(entry sync runs at app start / plugin enable-disable; use `mcp inject` to force)");
    } else {
        println!("(resolver disabled: hub entries removed; enable plugin `mcp-resolver` to turn on)");
    }
}
