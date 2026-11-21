//! 需求4 D4-8/D4-7（v0.9.8）：`jishu-cli extensions` 子命令。
//!
//! - `list`：登记簿全量查询（诊断/对账）。
//! - `verdict <pkg_key> <noneeded|pending> [--note]`：**agent GUI 适配第 0
//!   步判定落档通道**——判定「纯底层工具无需界面」时经本命令直写
//!   extensions.db，GUI 市场卡/已装页即时呈现「无需界面」并收起适配入口。

use crate::cli::args::ExtensionAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: ExtensionAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        ExtensionAction::List => list(ctx),
        ExtensionAction::Verdict {
            pkg_key,
            verdict,
            note,
        } => verdict_set(&pkg_key, &verdict, note.as_deref(), ctx),
    }
}

fn list(ctx: &ExecutionContext) -> Result<(), CliError> {
    crate::agent::extensions_db::ensure_schema()
        .map_err(|e| CliError::InvalidArg(format!("extensions.db 不可用: {e}")))?;
    let entries = crate::agent::extensions_db::registry_list()
        .map_err(|e| CliError::InvalidArg(format!("登记簿读取失败: {e}")))?;
    let deps = crate::agent::extensions_db::plugin_deps().unwrap_or_default();
    let by_plugin: std::collections::HashMap<String, Vec<String>> = deps
        .into_iter()
        .map(|d| {
            (
                d.plugin_id,
                d.deps.iter().map(|x| x.pkg_key.clone()).collect(),
            )
        })
        .collect();
    let rows: Vec<serde_json::Value> = entries
        .into_iter()
        .map(|e| {
            serde_json::json!({
                "pkg_key": e.pkg_key,
                "display": e.display,
                "builtin": e.builtin,
                "state": e.state,
                "gui_verdict": e.gui_verdict,
                "verdict_note": e.verdict_note,
                "adapters": e.adapters.iter().map(|a| serde_json::json!({
                    "plugin_id": a.plugin_id,
                    "enabled": a.enabled,
                    "cascade_disabled": a.cascade_disabled,
                })).collect::<Vec<_>>(),
                "adapted_by_deps": by_plugin.get(&e.pkg_key).cloned().unwrap_or_default(),
            })
        })
        .collect();
    if ctx.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({ "extensions": rows }))
                .unwrap_or_default()
        );
    } else {
        for r in &rows {
            let adapters = r["adapters"].as_array().map(|a| a.len()).unwrap_or(0);
            println!(
                "{}\t{}\tbuiltin={}\tstate={}\tverdict={}\tadapters={}",
                r["pkg_key"].as_str().unwrap_or("?"),
                r["display"].as_str().unwrap_or("?"),
                r["builtin"].as_bool().unwrap_or(false),
                r["state"].as_str().unwrap_or("?"),
                r["gui_verdict"].as_str().unwrap_or("?"),
                adapters
            );
        }
    }
    Ok(())
}

fn verdict_set(
    pkg_key: &str,
    verdict: &str,
    note: Option<&str>,
    _ctx: &ExecutionContext,
) -> Result<(), CliError> {
    crate::agent::extensions_db::ensure_schema()
        .map_err(|e| CliError::InvalidArg(format!("extensions.db 不可用: {e}")))?;
    crate::agent::extensions_db::set_verdict(pkg_key, verdict, note)
        .map_err(|e| CliError::InvalidArg(format!("判定落档失败: {e}")))?;
    // 判定变化可能收起/放出适配入口——刷新登记簿面（幂等）。
    crate::agent::extensions_db::sync_all();
    println!("已记录：{pkg_key} → {verdict}");
    Ok(())
}
