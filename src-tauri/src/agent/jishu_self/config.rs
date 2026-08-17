use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::config::{BackupEntry, McpServerConfig};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextCompaction {
    pub threshold: Option<f64>,
    pub method: Option<String>,
}

/// Jishu self-agent config schema. Independent of ClaudeConfig — each agent
/// owns its own file format, struct, and CRUD path.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JishuConfig {
    /// Pi Settings 真实字段（v0.7.4 R15 死字段整改：activeModel/temperature/
    /// maxTokens/thinkingEnabled/permissions/skipDangerous/verbose/maxTurns
    /// 均不在 Pi Settings schema 中，已删除——历史文件里的这些键经合并逻辑
    /// 原样保留、Pi 忽略）。真活的全局默认模型/激活模型在 Hub 侧
    ///（~/.jishu-hub/settings.json）与 models.json。
    #[serde(
        rename = "defaultThinkingLevel",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub default_thinking_level: Option<String>,

    pub env: Option<HashMap<String, String>>,

    pub mcp_servers: Option<HashMap<String, McpServerConfig>>,

    pub system_instructions: Option<String>,
    pub global_memory: Option<String>,
    pub context_compaction: Option<ContextCompaction>,
    pub theme: Option<String>,
}

fn jishu_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    Ok(home.join(".jishu-agent").join("agent")) // pi 原生 getAgentDir() 路径
}

pub fn jishu_config_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(jishu_dir()?.join("settings.json"))
}

fn jishu_backup_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(jishu_dir()?.join("backups"))
}

/// Sync mcpServers from JishuConfig to ~/.jishu-agent/mcp.json.
/// pi-mcp-adapter reads MCP server definitions from <Pi agent dir>/mcp.json,
/// not from settings.json's mcpServers field.
pub fn sync_mcp_json(config: &JishuConfig) -> Result<(), Box<dyn std::error::Error>> {
    let dir = jishu_dir()?;
    let mcp_path = dir.join("mcp.json");

    let mcp_content = if let Some(servers) = &config.mcp_servers {
        // Pass through all fields including `headers` for url-based servers.
        // Full ServerEntry is preserved so any pi-mcp-adapter field works.
        let entries: serde_json::Map<String, serde_json::Value> = servers
            .iter()
            .filter_map(|(name, entry)| serde_json::to_value(entry).ok().map(|v| (name.clone(), v)))
            .collect();
        let mut obj = serde_json::Map::new();
        obj.insert("mcpServers".to_string(), serde_json::Value::Object(entries));
        serde_json::to_string_pretty(&obj)?
    } else {
        // No mcpServers configured — write empty object so adapter sees no servers
        serde_json::to_string_pretty(&serde_json::json!({"mcpServers": {}}))?
    };

    crate::util::atomic_write(&mcp_path, mcp_content.as_bytes())?;
    Ok(())
}

/// Pi 原生项目级设置：<project>/.pi/settings.json（深合并覆盖全局；
/// 字段为 Pi Settings schema：defaultModel / defaultThinkingLevel 等，
/// 不含 permissions/env——行为参数块那些字段 Pi 并不读取）。
pub fn pi_project_settings_path(project_path: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(std::path::Path::new(project_path)
        .join(".pi")
        .join("settings.json"))
}

pub fn load_pi_project_settings_raw(
    project_path: &str,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let path = pi_project_settings_path(project_path)?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = std::fs::read_to_string(&path)?;
    if content.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    Ok(serde_json::from_str(&content)?)
}

/// 写项目 .pi/settings.json：只改 defaultModel / defaultThinkingLevel 两键，
/// 其余（含用户手写的 Pi 字段）原样保留；null = 删除该键。
pub fn save_pi_project_settings_fields(
    project_path: &str,
    model: Option<&str>,
    thinking_level: Option<&str>,
    compaction: Option<&crate::project_config::ProjectCompaction>,
) -> Result<(), Box<dyn std::error::Error>> {
    let path = pi_project_settings_path(project_path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut value = load_pi_project_settings_raw(project_path)?;
    let obj = value
        .as_object_mut()
        .ok_or(".pi/settings.json must be an object")?;
    // Pi 按 (defaultProvider, defaultModel) 二元组解析（model-resolver.ts:671），
    // "provider/model" 拆分写入；None/无法拆分 = 删除整组。
    match model.and_then(|m| m.split_once('/')) {
        Some((provider, model_id)) if !model_id.is_empty() => {
            obj.insert("defaultProvider".to_string(), serde_json::json!(provider));
            obj.insert("defaultModel".to_string(), serde_json::json!(model_id));
        }
        _ => {
            obj.remove("defaultProvider");
            obj.remove("defaultModel");
        }
    }
    match thinking_level {
        Some(l) if !l.is_empty() => {
            obj.insert("defaultThinkingLevel".to_string(), serde_json::json!(l));
        }
        _ => {
            obj.remove("defaultThinkingLevel");
        }
    }
    match compaction {
        Some(c) => {
            obj.insert("compaction".to_string(), serde_json::to_value(c)?);
        }
        None => {
            obj.remove("compaction");
        }
    }
    crate::util::atomic_write(&path, serde_json::to_string_pretty(&value)?.as_bytes())?;
    Ok(())
}

pub fn load_jishu_config() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let path = jishu_config_path()?;
    if !path.exists() {
        return Ok(serde_json::to_value(JishuConfig::default())?);
    }
    let content = std::fs::read_to_string(&path)?;
    let value: serde_json::Value = serde_json::from_str(&content).map_err(|e| {
        format!(
            "Failed to parse {}: {}",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("settings.json"),
            e
        )
    })?;
    Ok(value)
}

pub fn save_jishu_config(config: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
    let typed: JishuConfig = serde_json::from_value(config.clone())?;
    let path = jishu_config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    backup_jishu_config()?;

    let existing = if path.exists() {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str::<serde_json::Value>(&content).ok()
    } else {
        None
    };

    let mut new_value = serde_json::to_value(&typed).map_err(|e| e.to_string())?;

    if let Some(obj) = new_value.as_object_mut() {
        obj.retain(|_, v| !v.is_null());
    }

    if let (Some(existing_obj), Some(new_obj)) = (existing, new_value.as_object_mut()) {
        for (key, value) in existing_obj.as_object().unwrap_or(&serde_json::Map::new()) {
            if !new_obj.contains_key(key) {
                new_obj.insert(key.clone(), value.clone());
            }
        }
    }

    let json = serde_json::to_string_pretty(&new_value).map_err(|e| e.to_string())?;
    crate::util::atomic_write(&path, json.as_bytes()).map_err(|e| e.to_string())?;

    let written = std::fs::read_to_string(&path)?;
    let _: JishuConfig = serde_json::from_str(&written)?;

    // Sync mcpServers to ~/.jishu-agent/mcp.json for pi-mcp-adapter
    sync_mcp_json(&typed)?;

    Ok(())
}

pub fn backup_jishu_config() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = jishu_dir()?;
    std::fs::create_dir_all(&dir)?;
    let backup_dir = jishu_backup_dir()?;
    std::fs::create_dir_all(&backup_dir)?;
    let src = jishu_config_path()?;
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let dst = backup_dir.join(format!("settings_{}.json", timestamp));
    if src.exists() {
        std::fs::copy(&src, &dst)?;
    }
    cleanup_old_jishu_backups(&backup_dir, 10)?;
    Ok(dst)
}

fn cleanup_old_jishu_backups(
    backup_dir: &std::path::Path,
    keep: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut backups: Vec<std::path::PathBuf> = std::fs::read_dir(backup_dir)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext == "json")
                .unwrap_or(false)
                && e.file_name().to_string_lossy().starts_with("settings_")
        })
        .map(|e| e.path())
        .collect();
    if backups.len() <= keep {
        return Ok(());
    }
    backups.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    for old in backups.iter().skip(keep) {
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

pub fn list_jishu_backups() -> Result<Vec<BackupEntry>, Box<dyn std::error::Error>> {
    let backup_dir = jishu_backup_dir()?;
    if !backup_dir.exists() {
        return Ok(Vec::new());
    }
    let mut backups: Vec<BackupEntry> = std::fs::read_dir(&backup_dir)?
        .filter_map(|e| e.ok())
        .map(|e| {
            let path = e.path();
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            // settings_ / models_ 两种前缀共用同一时间戳格式（v0.7.4：渠道
            // 配置改动也会自动备份 models_*.json）。
            let timestamp = ["settings_", "models_"].iter().find_map(|prefix| {
                path.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .strip_prefix(prefix)
                    .and_then(|s| {
                        chrono::NaiveDateTime::parse_from_str(s, "%Y%m%d_%H%M%S")
                            .ok()
                            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                    })
            });
            BackupEntry {
                name,
                path: path.to_string_lossy().to_string(),
                timestamp,
            }
        })
        .filter(|b| b.name.ends_with(".json"))
        .collect();
    backups.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(backups)
}

pub fn restore_jishu_backup(backup_path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let name = std::path::Path::new(backup_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let content = std::fs::read_to_string(backup_path)?;
    if name.starts_with("models_") {
        // 渠道/模型库备份：校验后恢复到 agent 目录的 models.json。
        let parsed: crate::agent::jishu_self::pi_models_config::PiModelsConfig =
            serde_json::from_str(&content)?;
        let dst = crate::agent::jishu_self::pi_models_config::default_models_path()?;
        let json = serde_json::to_string_pretty(&parsed)?;
        crate::util::atomic_write(&dst, format!("{json}\n").as_bytes())?;
        return Ok(());
    }
    let dst = jishu_config_path()?;
    let _: JishuConfig = serde_json::from_str(&content)?;
    crate::util::atomic_write(&dst, content.as_bytes())?;
    Ok(())
}

pub fn export_jishu_config(export_path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let src = jishu_config_path()?;
    let content = std::fs::read_to_string(&src)?;
    crate::util::atomic_write(std::path::Path::new(export_path), content.as_bytes())?;
    Ok(())
}

pub fn import_jishu_config(
    import_path: &str,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(import_path)?;
    let value: serde_json::Value = serde_json::from_str(&content)?;
    let _: JishuConfig = serde_json::from_value(value.clone())?;
    let dst = jishu_config_path()?;
    backup_jishu_config()?;
    crate::util::atomic_write(&dst, content.as_bytes())?;
    Ok(value)
}

pub fn load_raw_jishu_config() -> Result<String, Box<dyn std::error::Error>> {
    let path = jishu_config_path()?;
    if !path.exists() {
        return Ok(String::new());
    }
    Ok(std::fs::read_to_string(&path)?)
}

pub fn save_raw_jishu_config(content: &str) -> Result<(), Box<dyn std::error::Error>> {
    let _: serde_json::Value = serde_json::from_str(content)?;
    backup_jishu_config()?;
    let path = jishu_config_path()?;
    crate::util::atomic_write(&path, content.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {

    #[test]
    fn pi_project_settings_round_trip_preserves_unknown_keys() {
        let dir = std::env::temp_dir().join(format!("pi-proj-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let proj = dir.to_string_lossy().to_string();

        assert_eq!(
            load_pi_project_settings_raw(&proj).unwrap(),
            serde_json::json!({})
        );
        save_pi_project_settings_fields(
            &proj,
            Some("zhipu/glm-5.3"),
            Some("high"),
            Some(&crate::project_config::ProjectCompaction {
                enabled: Some(false),
                reserve_tokens: Some(8192),
                keep_recent_tokens: None,
            }),
        )
        .unwrap();
        let raw = load_pi_project_settings_raw(&proj).unwrap();
        // 二元组拆分写入
        assert_eq!(raw["defaultProvider"], serde_json::json!("zhipu"));
        assert_eq!(raw["defaultModel"], serde_json::json!("glm-5.3"));
        assert_eq!(raw["defaultThinkingLevel"], serde_json::json!("high"));
        assert_eq!(raw["compaction"]["enabled"], serde_json::json!(false));
        assert_eq!(raw["compaction"]["reserveTokens"], serde_json::json!(8192));
        assert!(
            raw["compaction"].get("keepRecentTokens").is_none(),
            "None 字段不落盘"
        );

        let path = pi_project_settings_path(&proj).unwrap();
        let mut with_extra: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        with_extra["theme"] = serde_json::json!("dark");
        std::fs::write(&path, serde_json::to_string(&with_extra).unwrap()).unwrap();
        save_pi_project_settings_fields(&proj, None, None, None).unwrap();
        let raw = load_pi_project_settings_raw(&proj).unwrap();
        assert!(raw.get("defaultModel").is_none(), "None removes the pair");
        assert!(raw.get("defaultProvider").is_none());
        assert!(raw.get("defaultThinkingLevel").is_none());
        assert!(raw.get("compaction").is_none());
        assert_eq!(raw["theme"], serde_json::json!("dark"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;

    #[test]
    fn jishu_config_round_trip() {
        // R15 死字段整改后：真实字段 = defaultThinkingLevel / env / mcpServers /
        // systemInstructions / globalMemory / contextCompaction / theme。
        let cfg = JishuConfig {
            default_thinking_level: Some("high".to_string()),
            env: Some({
                let mut m = HashMap::new();
                m.insert("FOO".to_string(), "bar".to_string());
                m
            }),
            mcp_servers: Some(HashMap::new()),
            system_instructions: Some("You are a coding assistant".to_string()),
            global_memory: Some("remember the user's preferences".to_string()),
            context_compaction: Some(ContextCompaction {
                threshold: Some(0.85),
                method: Some("summary".to_string()),
            }),
            theme: Some("dark".to_string()),
        };
        let value = serde_json::to_value(cfg.clone()).unwrap();
        let restored: JishuConfig = serde_json::from_value(value).unwrap();
        assert_eq!(restored.default_thinking_level, cfg.default_thinking_level);
        assert_eq!(restored.theme, cfg.theme);
    }

    #[test]
    fn jishu_config_camel_case_field_names() {
        let value = serde_json::to_value(JishuConfig {
            default_thinking_level: Some("low".to_string()),
            system_instructions: Some("hi".to_string()),
            global_memory: Some("mem".to_string()),
            context_compaction: Some(ContextCompaction {
                threshold: Some(0.5),
                method: Some("truncate".to_string()),
            }),
            ..Default::default()
        })
        .unwrap();
        let obj = value.as_object().unwrap();
        assert!(obj.contains_key("defaultThinkingLevel"));
        assert!(obj.contains_key("systemInstructions"));
        assert!(obj.contains_key("globalMemory"));
        assert!(obj.contains_key("contextCompaction"));
        assert!(!obj.contains_key("default_thinking_level"));
    }
}
