//! 四家智能体 MCP 配置注入/回收（v0.9.0 需求1 P2，方案 b 聚合代理）。
//!
//! 有启用的 [mcp] 插件时，向四家（claude-code / codex / opencode / jishu-self）
//! 配置各写入一条 `jishu-hub` 条目（command = jishu-cli 绝对路径，
//! args = ["mcp","serve"]）；全部 MCP 插件禁用时回收该条目。工具增删不在
//! 配置层发生——由聚合 server 每次 tools/list 动态生效（条目常驻）。
//!
//! 同名保护：用户自建的 `jishu-hub` 条目（args 形态不符）不覆盖、不回收，
//! 记 Protected 状态。四家写入通道均带备份与原子写（既有实现）。
//! 纯变换函数（upsert/remove）可单测；文件级 sync 触碰真实用户配置，
//! 回归走真机验证（03 §二）。

use serde_json::{json, Value};

use crate::agent::mcp_server::{load_mcp_plugin_decls, HUB_MCP_ENTRY_NAME};
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

/// 同步入口：有启用的 [mcp] 插件 → 四家 upsert；无 → 四家 remove。
/// 单家失败不阻断其余（各通道独立文件），失败记入报告（Error: …）。
pub fn sync_hub_mcp_entries() -> SyncReport {
    let has_mcp_plugins = !load_mcp_plugin_decls().is_empty();
    sync_all(has_mcp_plugins)
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

fn sync_all(has_mcp_plugins: bool) -> SyncReport {
    let mut report = SyncReport::default();

    // claude-code：结构化 struct 面（load_config/save_config of ClaudeConfig）。
    report.claude_code = match crate::config::load_config() {
        Ok(mut cfg) => {
            let servers = cfg.mcp_servers.get_or_insert_with(Default::default);
            let args_now = servers
                .get(HUB_MCP_ENTRY_NAME)
                .and_then(|e| e.args.clone())
                .unwrap_or_default();
            let status = if has_mcp_plugins {
                match servers.get(HUB_MCP_ENTRY_NAME) {
                    None => "Injected",
                    Some(_) if looks_like_hub_entry(&args_now) => "Updated",
                    Some(_) => "Protected",
                }
            } else if looks_like_hub_entry(&args_now) {
                servers.remove(HUB_MCP_ENTRY_NAME);
                "Removed"
            } else if servers.contains_key(HUB_MCP_ENTRY_NAME) {
                "Protected"
            } else {
                "Noop"
            };
            if status == "Injected" || status == "Updated" {
                servers.insert(
                    HUB_MCP_ENTRY_NAME.to_string(),
                    crate::config::McpServerConfig {
                        command: resolve_cli_path().ok(),
                        args: Some(vec!["mcp".into(), "serve".into()]),
                        env: None,
                        cwd: None,
                        server_type: None,
                        url: None,
                        headers: None,
                    },
                );
            }
            match crate::config::save_config(&cfg) {
                Ok(()) => status.to_string(),
                Err(e) => format!("Error: {e}"),
            }
        }
        Err(e) => format!("Error: {e}"),
    };

    // codex：ConfigAdapter Value 面（键 mcpServers；save 全量替换 mcp_servers
    // 表，增删均生效）。
    report.codex = sync_via_adapter(
        &crate::agent::adapters::codex::CodexAdapter::new(),
        has_mcp_plugins,
    );

    // opencode：注入走 adapter（merge 语义可增改）；回收必须走原始层删除
    // （merge 只增不删，见 remove_mcp_entry_raw 注释）。
    report.opencode = if has_mcp_plugins {
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

    // jishu-self：settings.json Value 面（键 mcp_servers，snake_case），
    // save_jishu_config 内部同步 mcp.json（pi-mcp-adapter 读取面）。
    report.jishu_self = match crate::agent::jishu_self::config::load_jishu_config() {
        Ok(mut v) => {
            let status = sync_json_value(&mut v, "mcp_servers", has_mcp_plugins);
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

fn sync_json_value(v: &mut Value, servers_key: &str, has_mcp_plugins: bool) -> &'static str {
    if has_mcp_plugins {
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
    has_mcp_plugins: bool,
) -> String {
    match adapter.load_config() {
        Ok(mut v) => {
            let status = sync_json_value(&mut v, "mcpServers", has_mcp_plugins);
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
    fn jishu_self_key_is_snake_case() {
        // jishu settings.json 的键为 mcp_servers（snake_case，JishuConfig 序列化）。
        let mut cfg = json!({});
        assert_eq!(upsert_entry_json(&mut cfg, "mcp_servers", "/bin/jishu-cli"), "Injected");
        assert!(cfg["mcp_servers"][HUB_MCP_ENTRY_NAME].is_object());
        assert!(cfg.get("mcpServers").is_none());
    }
}
