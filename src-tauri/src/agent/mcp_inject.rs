//! 四家智能体 MCP 配置注入/回收（v0.9.0 需求1 P2，方案 b 聚合代理；
//! 二期门控反转）。
//!
//! MCP 解析器（mcp-resolver 系统插件，默认安装+启用）开 → 向四家
//!（claude-code / codex / opencode / jishu-self）配置各写入一条
//! `jishu-hub` 条目（command = jishu-cli 绝对路径，args = ["mcp","serve"]）；
//! 解析器关 → 回收该条目。有无 [mcp] 插件不再影响条目（一期「有插件才
//! 注入」使内置 hub 工具在无插件时不可达，属倒挂；工具增删由聚合 server
//! 每次 tools/list 动态生效，条目常驻）。
//!
//! 同名保护：用户自建的 `jishu-hub` 条目（args 形态不符）不覆盖、不回收，
//! 记 Protected 状态。四家写入通道均带备份与原子写（既有实现）。
//! 纯变换函数（upsert/remove）可单测；文件级 sync 触碰真实用户配置，
//! 回归走真机验证（03 §二）。

use serde_json::{json, Value};

use crate::agent::mcp_server::HUB_MCP_ENTRY_NAME;
use crate::agent::traits::ConfigAdapter;

/// hub 条目的识别签名：args 前两项恰为 mcp / serve（command 路径随安装
/// 位置变化，不作判据）。
fn looks_like_hub_entry(args: &[String]) -> bool {
    args.first().map(String::as_str) == Some("mcp") && args.get(1).map(String::as_str) == Some("serve")
}

fn entry_args_of(v: &Value) -> Vec<String> {
    v.get("args")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

/// JSON 形态 upsert：在 `servers_key` 对象内写 hub 条目。
/// 返回 Injected（新写）/ Updated（更新自家旧条目）/ Protected（同名非自家）。
pub fn upsert_entry_json(config_json: &mut Value, servers_key: &str, cli_path: &str) -> &'static str {
    let entry = json!({
        "command": cli_path,
        "args": ["mcp", "serve"],
    });
    if !config_json
        .get(servers_key)
        .map(Value::is_object)
        .unwrap_or(false)
    {
        config_json[servers_key] = json!({});
    }
    let servers = config_json
        .get_mut(servers_key)
        .and_then(Value::as_object_mut)
        .expect("servers object just ensured");
    match servers.get(HUB_MCP_ENTRY_NAME) {
        None => {
            servers.insert(HUB_MCP_ENTRY_NAME.to_string(), entry);
            "Injected"
        }
        Some(existing) => {
            if looks_like_hub_entry(&entry_args_of(existing)) {
                servers.insert(HUB_MCP_ENTRY_NAME.to_string(), entry);
                "Updated"
            } else {
                "Protected"
            }
        }
    }
}

/// JSON 形态回收：仅当条目形态属自家时删除。返回 Removed/Protected/Noop。
pub fn remove_entry_json(config_json: &mut Value, servers_key: &str) -> &'static str {
    let Some(servers) = config_json.get_mut(servers_key).and_then(Value::as_object_mut)
    else {
        return "Noop";
    };
    let Some(existing) = servers.get(HUB_MCP_ENTRY_NAME)
    else {
        return "Noop";
    };
    if looks_like_hub_entry(&entry_args_of(existing)) {
        servers.remove(HUB_MCP_ENTRY_NAME);
        "Removed"
    } else {
        "Protected"
    }
}

#[derive(Debug, Default, serde::Serialize)]
pub struct SyncReport {
    pub claude_code: String,
    pub codex: String,
    pub opencode: String,
    pub jishu_self: String,
}

/// jishu-cli 绝对路径（hub 进程内定位同级 CLI；CLI 进程内即自身）。
pub fn resolve_cli_path() -> Result<String, String> {
    crate::agent::jishu_self::resolve_jishu_cli_binary()
        .map(|p| p.to_string_lossy().to_string())
}

/// 同步入口（二期门控反转）：MCP 解析器（mcp-resolver，默认启用）开 →
/// 四家 upsert；关 → 四家 remove。有无 [mcp] 插件不影响条目。
pub fn sync_hub_mcp_entries() -> SyncReport {
    sync_all(crate::agent::plugin::is_mcp_resolver_enabled())
}

/// 强制回收（`jishu-cli mcp remove`）：不论插件状态，四家移除自家条目。
pub fn remove_all_entries() -> SyncReport {
    sync_all(false)
}

/// 强制注入（`jishu-cli mcp inject`）：不论插件状态，四家写入条目
/// （显式命令 = 显式意图；自动同步见 sync_hub_mcp_entries 的条件语义）。
pub fn force_inject_all() -> SyncReport {
    sync_all(true)
}

fn sync_all(resolver_on: bool) -> SyncReport {
    let mut report = SyncReport::default();

    // claude-code：user-scope 权威文件 ~/.claude.json 顶层 mcpServers（Value 面，
    // 备份+原子写）。v0.9.0 需求20 第二轮根因修复：一期写 settings.json 的
    // mcpServers——Claude Code 不加载该文件的服务器定义，agent 无法发现
    // jishu-hub；同时清理 settings.json 中一期的死条目（仅自家形态）。
    report.claude_code = match crate::config::load_claude_user_config_value() {
        Ok(mut v) => {
            let status = sync_json_value(&mut v, "mcpServers", resolver_on);
            if status == "Error" {
                "Error".to_string()
            } else {
                match crate::config::save_claude_user_config_value(&v) {
                    Ok(()) => {
                        cleanup_stale_claude_settings_entry(resolver_on);
                        status.to_string()
                    }
                    Err(e) => format!("Error: {e}"),
                }
            }
        }
        Err(e) => format!("Error: {e}"),
    };

    // codex：ConfigAdapter Value 面（键 mcpServers；save 全量替换 mcp_servers
    // 表，增删均生效）。
    report.codex = sync_via_adapter(
        &crate::agent::adapters::codex::CodexAdapter::new(),
        resolver_on,
    );

    // opencode：注入走 adapter（merge 语义可增改）；回收必须走原始层删除
    // （merge 只增不删，见 remove_mcp_entry_raw 注释）。
    report.opencode = if resolver_on {
        sync_via_adapter(
            &crate::agent::adapters::opencode::OpencodeAdapter::new(),
            true,
        )
    } else {
        match crate::agent::adapters::opencode::remove_mcp_entry_raw(HUB_MCP_ENTRY_NAME) {
            Ok(true) => "Removed".to_string(),
            Ok(false) => "Noop".to_string(),
            Err(e) => format!("Error: {e}"),
        }
    };

    // jishu-self：settings.json Value 面，键 mcpServers（camelCase——
    // JishuConfig 带 rename_all = "camelCase"，蛇形键解析为 None 导致 mcp.json
    // 恒空，v0.9.0 需求20 第二轮根因修复）；save_jishu_config 内部同步
    // mcp.json（pi-mcp-adapter 的 Pi 全局覆盖位）。顺手清理一期写入的
    // 蛇形死键。
    report.jishu_self = match crate::agent::jishu_self::config::load_jishu_config() {
        Ok(mut v) => {
            // 一期死键清理：merge 语义「未提及即保留」，须显式 null 才删除。
            v["mcp_servers"] = Value::Null;
            if let Some(obj) = v.as_object_mut() {
                obj.remove("mcp_servers");
                obj.insert("mcp_servers".to_string(), Value::Null);
            }
            let status = sync_json_value(&mut v, "mcpServers", resolver_on);
            match crate::agent::jishu_self::config::save_jishu_config(&v) {
                Ok(()) => status.to_string(),
                Err(e) => format!("Error: {e}"),
            }
        }
        Err(e) => format!("Error: {e}"),
    };

    for (agent, status) in [
        ("claude-code", &report.claude_code),
        ("codex", &report.codex),
        ("opencode", &report.opencode),
        ("jishu-self", &report.jishu_self),
    ] {
        log::info!("[hub-mcp-inject] {agent}: {status}");
    }
    report
}

/// settings.json 的 mcpServers 里一期写入的 jishu-hub 死条目清理（仅自家
/// 形态；Claude Code 不读此文件的服务器定义，留着只会误导手写通道视图）。
fn cleanup_stale_claude_settings_entry(_resolver_on: bool) {
    let Ok(mut cfg) = crate::config::load_config() else {
        return;
    };
    let Some(servers) = cfg.mcp_servers.as_mut() else {
        return;
    };
    let is_ours = servers
        .get(HUB_MCP_ENTRY_NAME)
        .and_then(|e| e.args.clone())
        .map(|args| looks_like_hub_entry(&args))
        .unwrap_or(false);
    if is_ours {
        servers.remove(HUB_MCP_ENTRY_NAME);
        if cfg.mcp_servers.as_ref().map(|m| m.is_empty()).unwrap_or(false) {
            cfg.mcp_servers = None;
        }
        let _ = crate::config::save_config(&cfg);
    }
}

fn sync_json_value(v: &mut Value, servers_key: &str, resolver_on: bool) -> &'static str {
    if resolver_on {
        match resolve_cli_path() {
            Ok(cli) => upsert_entry_json(v, servers_key, &cli),
            Err(e) => {
                log::warn!("[hub-mcp-inject] resolve cli path failed: {e}");
                "Error"
            }
        }
    } else {
        remove_entry_json(v, servers_key)
    }
}

fn sync_via_adapter(
    adapter: &dyn ConfigAdapter,
    resolver_on: bool,
) -> String {
    match adapter.load_config() {
        Ok(mut v) => {
            let status = sync_json_value(&mut v, "mcpServers", resolver_on);
            if status == "Error" {
                return "Error".to_string();
            }
            match adapter.save_config(&v) {
                Ok(()) => status.to_string(),
                Err(e) => format!("Error: {e}"),
            }
        }
        Err(e) => format!("Error: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_inject_update_protect() {
        let mut cfg = json!({});
        assert_eq!(upsert_entry_json(&mut cfg, "mcpServers", "/bin/jishu-cli"), "Injected");
        assert_eq!(
            cfg["mcpServers"][HUB_MCP_ENTRY_NAME]["args"],
            json!(["mcp", "serve"])
        );
        // 自家旧条目（路径变化）→ Updated 覆盖。
        cfg["mcpServers"][HUB_MCP_ENTRY_NAME]["command"] = json!("/old/path/jishu-cli");
        assert_eq!(upsert_entry_json(&mut cfg, "mcpServers", "/new/jishu-cli"), "Updated");
        assert_eq!(cfg["mcpServers"][HUB_MCP_ENTRY_NAME]["command"], json!("/new/jishu-cli"));
        // 用户自建同名条目（args 形态不符）→ Protected 不动。
        cfg["mcpServers"][HUB_MCP_ENTRY_NAME] = json!({ "url": "http://x", "args": ["--stdio"] });
        assert_eq!(upsert_entry_json(&mut cfg, "mcpServers", "/bin/jishu-cli"), "Protected");
        assert_eq!(cfg["mcpServers"][HUB_MCP_ENTRY_NAME]["url"], json!("http://x"));
    }

    #[test]
    fn remove_respects_ownership() {
        let mut cfg = json!({
            "mcpServers": {
                "jishu-hub": { "command": "/x/jishu-cli", "args": ["mcp", "serve"] },
                "user-tool": { "command": "npx" },
            }
        });
        assert_eq!(remove_entry_json(&mut cfg, "mcpServers"), "Removed");
        assert!(cfg["mcpServers"].get("jishu-hub").is_none());
        assert!(cfg["mcpServers"].get("user-tool").is_some());
        // 二次删除 → Noop。
        assert_eq!(remove_entry_json(&mut cfg, "mcpServers"), "Noop");
        // 非自家条目 → Protected。
        let mut cfg2 = json!({ "mcpServers": { "jishu-hub": { "url": "http://x" } } });
        assert_eq!(remove_entry_json(&mut cfg2, "mcpServers"), "Protected");
    }

    #[test]
    fn jishu_self_key_is_camel_case() {
        // v0.9.0 需求20 第二轮根因修复：JishuConfig 带 rename_all="camelCase"，
        // 键必须是 mcpServers（一期误用蛇形 mcp_servers，typed 解析恒 None →
        // mcp.json 恒空 → pi-mcp-adapter 拿不到任何 server）。
        let mut cfg = json!({});
        assert_eq!(upsert_entry_json(&mut cfg, "mcpServers", "/bin/jishu-cli"), "Injected");
        assert!(cfg["mcpServers"][HUB_MCP_ENTRY_NAME].is_object());
        assert!(cfg.get("mcp_servers").is_none());
    }

    #[test]
    fn claude_user_config_plane_roundtrip() {
        // claude-code user-scope 平面 = ~/.claude.json 顶层 mcpServers（与
        // codex/opencode 相同的 upsert/remove 纯函数，键名不同）。
        let mut cfg = json!({ "numStartups": 42, "mcpServers": { "user-tool": { "command": "npx" } } });
        assert_eq!(upsert_entry_json(&mut cfg, "mcpServers", "/bin/jishu-cli"), "Injected");
        assert_eq!(
            cfg["mcpServers"][HUB_MCP_ENTRY_NAME]["args"],
            json!(["mcp", "serve"])
        );
        assert_eq!(cfg["numStartups"], json!(42)); // 其余键原样保留
        assert_eq!(remove_entry_json(&mut cfg, "mcpServers"), "Removed");
        assert!(cfg["mcpServers"].get(HUB_MCP_ENTRY_NAME).is_none());
        assert!(cfg["mcpServers"].get("user-tool").is_some());
    }
}
