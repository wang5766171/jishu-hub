//! 原生 MCP 服务管理面（v0.9.5 需求11 追加三 A：pi 1.1.0 原生 mcp.json 的
//! GUI 管理——用户经 `pi mcp add` 或手写的条目此前对 hub 完全不可见）。
//!
//! 职责边界：只管 `~/.jishu-agent/agent/mcp.json` 中**非 jishu-hub** 的用户
//! 条目（键级增删改/启停/状态展示）；jishu-hub 键由 mcp-resolver 启停联动
//! 与 ensure_native_mcp_entry 自愈专管，本面不显示不操作（防打架）。项目级
//! `.pi/mcp.json` 属 pi trust 语义，不介入。状态探活经 `jishu mcp list`
//! 子进程解析（connected/failed/disabled），spawn 纪律沿用 shell_command
//! + tokio_no_window（Windows 无窗口）+ 20s 超时。

use serde_json::{json, Value};
use std::collections::HashMap;

use crate::agent::jishu_self::paths;

const PROBE_TIMEOUT_SECS: u64 = 20;

fn mcp_json_path() -> Result<std::path::PathBuf, String> {
    paths::mcp_json_path().map_err(|e| e.to_string())
}

fn read_servers_map() -> Result<serde_json::Map<String, Value>, String> {
    let path = mcp_json_path()?;
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let root: Value = std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())?
        .parse()
        .map_err(|e| format!("mcp.json 解析失败: {e}"))?;
    Ok(root
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default())
}

fn write_servers_map(servers: &serde_json::Map<String, Value>) -> Result<(), String> {
    let path = mcp_json_path()?;
    // 键级保留：读原文档，只替换 mcpServers（其他顶层键原样保留）。
    let mut root: Value = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| c.parse().ok())
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    root["mcpServers"] = Value::Object(servers.clone());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::util::atomic_write(
        &path,
        serde_json::to_string_pretty(&root).unwrap().as_bytes(),
    )
    .map_err(|e| e.to_string())
}

/// 列出原生 MCP 服务（非 jishu-hub 条目）。`probe=true` 时经
/// `jishu mcp list` 探活（spawn 子进程 + 20s 超时，前端按需开启）。
#[tauri::command]
pub(crate) async fn native_mcp_list(probe: bool) -> Result<Value, String> {
    let hub_key = crate::agent::mcp_server::HUB_MCP_ENTRY_NAME;
    let servers = read_servers_map()?;
    let mut out = Vec::new();
    for (name, entry) in &servers {
        if name == hub_key {
            continue;
        }
        let transport = if entry.get("url").is_some() {
            "http"
        } else {
            "stdio"
        };
        let enabled = entry
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let endpoint = entry
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| {
                entry
                    .get("command")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default();
        out.push(json!({
            "name": name,
            "transport": transport,
            "endpoint": endpoint,
            "enabled": enabled,
            "description": entry.get("description").and_then(|v| v.as_str()).unwrap_or(""),
            "needs_oauth": entry.get("oauth").is_some(),
            "status": if enabled { "unknown" } else { "disabled" },
        }));
    }
    if probe {
        if let Ok(statuses) = probe_statuses().await {
            for item in out.iter_mut() {
                if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                    if let Some(st) = statuses.get(name) {
                        item["status"] = json!(st);
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| {
        a.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or(""))
    });
    Ok(Value::Array(out))
}

/// `jishu mcp list` 输出解析：行形如
/// `name: connected, 21 tools (codemode, global)` / `name: failed (...)` /
/// `name: disabled (...)`。解析失败返回空 map（状态降级 unknown）。
async fn probe_statuses() -> Result<HashMap<String, String>, String> {
    let cli = crate::agent::jishu_self::resolve_jishu_cli_binary()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    let mut cmd = crate::os_adapter::shell::shell_command(&cli, vec!["mcp".into(), "list".into()]);
    cmd.current_dir(std::env::temp_dir());
    #[cfg(target_os = "windows")]
    crate::process_command::tokio_no_window(&mut cmd);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(PROBE_TIMEOUT_SECS),
        cmd.output(),
    )
    .await
    .map_err(|_| "jishu mcp list 超时".to_string())?
    .map_err(|e| format!("spawn jishu mcp list 失败: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let mut map = HashMap::new();
    for line in text.lines() {
        let Some((name, rest)) = line.split_once(": ") else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let status = if rest.starts_with("connected") {
            "connected"
        } else if rest.starts_with("failed") {
            "failed"
        } else if rest.starts_with("disabled") || rest.starts_with("parked") {
            "disabled"
        } else {
            "unknown"
        };
        map.insert(name.to_string(), status.to_string());
    }
    Ok(map)
}

/// 新增/更新原生 MCP 服务（键级 upsert；名字仅字母数字/_/-，与 pi 规则一致）。
/// entry 形如 `{"command": "...", "args": [...]}`（stdio）或
/// `{"url": "...", "headers": {...}}`（HTTP）；enabled/description 可选。
#[tauri::command]
pub(crate) fn native_mcp_upsert(name: String, entry: Value) -> Result<(), String> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("服务名只能包含字母、数字、下划线和连字符".to_string());
    }
    let hub_key = crate::agent::mcp_server::HUB_MCP_ENTRY_NAME;
    if name == hub_key {
        return Err("该名称为 hub 保留（jishu-hub 聚合服务由 MCP 解析器管理）".to_string());
    }
    let has_command = entry.get("command").and_then(|v| v.as_str()).is_some();
    let has_url = entry.get("url").and_then(|v| v.as_str()).is_some();
    if !has_command && !has_url {
        return Err("stdio 服务需提供 command，HTTP 服务需提供 url".to_string());
    }
    if has_command && has_url {
        return Err("command 与 url 二选一".to_string());
    }
    let mut servers = read_servers_map()?;
    servers.insert(name, entry);
    write_servers_map(&servers)
}

/// 删除原生 MCP 服务（键级；jishu-hub 保护）。
#[tauri::command]
pub(crate) fn native_mcp_remove(name: String) -> Result<(), String> {
    let hub_key = crate::agent::mcp_server::HUB_MCP_ENTRY_NAME;
    if name == hub_key {
        return Err("jishu-hub 聚合服务不可在此删除（请用 MCP 解析器启停）".to_string());
    }
    let mut servers = read_servers_map()?;
    if servers.remove(&name).is_none() {
        return Err(format!("服务 {name} 不存在"));
    }
    write_servers_map(&servers)
}

/// 启停原生 MCP 服务（写 enabled；pi 下轮 spawn 生效，运行中会话不变）。
#[tauri::command]
pub(crate) fn native_mcp_toggle(name: String, enabled: bool) -> Result<(), String> {
    let hub_key = crate::agent::mcp_server::HUB_MCP_ENTRY_NAME;
    if name == hub_key {
        return Err("jishu-hub 聚合服务不可在此启停（请用 MCP 解析器）".to_string());
    }
    let mut servers = read_servers_map()?;
    let Some(entry) = servers.get_mut(&name) else {
        return Err(format!("服务 {name} 不存在"));
    };
    if enabled {
        if let Some(obj) = entry.as_object_mut() {
            obj.remove("enabled");
        }
    } else if let Some(obj) = entry.as_object_mut() {
        obj.insert("enabled".to_string(), Value::Bool(false));
    }
    write_servers_map(&servers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_remove_roundtrip_isolated_by_home() {
        // HOME 隔离（env_test_lock 防并发环境变量竞争，plugin.rs 测试同纪律）。
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        let prev = std::env::var("USERPROFILE").ok();
        #[cfg(target_os = "windows")]
        std::env::set_var("USERPROFILE", &home);
        #[cfg(not(target_os = "windows"))]
        std::env::set_var("HOME", &home);

        let r = native_mcp_upsert("docs".into(), json!({"url": "https://example.com/mcp"}));
        assert!(r.is_ok());
        // USERPROFILE 指向 tmp 后 paths 解析应命中 tmp 下的 mcp.json。
        let list = read_servers_map().unwrap();
        assert!(list.contains_key("docs"));

        // jishu-hub 保护
        assert!(native_mcp_upsert("jishu-hub".into(), json!({"url": "x"})).is_err());
        assert!(native_mcp_remove("jishu-hub".into()).is_err());
        assert!(native_mcp_toggle("jishu-hub".into(), false).is_err());
        // 非法名/非法条目
        assert!(native_mcp_upsert("bad name!".into(), json!({"url": "x"})).is_err());
        assert!(native_mcp_upsert("empty".into(), json!({})).is_err());
        // toggle 写 enabled=false / 恢复
        assert!(native_mcp_toggle("docs".into(), false).is_ok());
        assert_eq!(
            read_servers_map().unwrap()["docs"]["enabled"],
            Value::Bool(false)
        );
        assert!(native_mcp_toggle("docs".into(), true).is_ok());
        assert!(read_servers_map().unwrap()["docs"].get("enabled").is_none());
        // 删除
        assert!(native_mcp_remove("docs".into()).is_ok());
        assert!(!read_servers_map().unwrap().contains_key("docs"));

        #[cfg(target_os = "windows")]
        {
            match prev {
                Some(v) => std::env::set_var("USERPROFILE", v),
                None => std::env::remove_var("USERPROFILE"),
            }
        }
        #[cfg(not(target_os = "windows"))]
        std::env::remove_var("HOME");
    }
}
