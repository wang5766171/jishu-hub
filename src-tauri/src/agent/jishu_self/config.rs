use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::config::{BackupEntry, McpServerConfig};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JishuPermissions {
    pub allow: Option<Vec<String>>,
    pub deny: Option<Vec<String>>,
    pub default_mode: Option<String>,
}

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
    pub active_model: Option<String>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub thinking_enabled: Option<bool>,

    pub env: Option<HashMap<String, String>>,

    pub permissions: Option<JishuPermissions>,
    pub skip_dangerous: Option<bool>,

    pub mcp_servers: Option<HashMap<String, McpServerConfig>>,

    pub system_instructions: Option<String>,
    pub global_memory: Option<String>,
    pub context_compaction: Option<ContextCompaction>,

    pub verbose: Option<bool>,
    pub max_turns: Option<u32>,
    pub theme: Option<String>,
}

fn jishu_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    Ok(home.join(".jishu-agent"))
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
            let timestamp = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .strip_prefix("settings_")
                .and_then(|s| {
                    chrono::NaiveDateTime::parse_from_str(s, "%Y%m%d_%H%M%S")
                        .ok()
                        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
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
    let dst = jishu_config_path()?;
    let content = std::fs::read_to_string(backup_path)?;
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
    use super::*;

    #[test]
    fn jishu_config_round_trip() {
        let cfg = JishuConfig {
            active_model: Some("claude-sonnet-4-6".to_string()),
            temperature: Some(0.7),
            max_tokens: Some(8192),
            thinking_enabled: Some(true),
            env: Some({
                let mut m = HashMap::new();
                m.insert("FOO".to_string(), "bar".to_string());
                m
            }),
            permissions: Some(JishuPermissions {
                allow: Some(vec!["Read".to_string()]),
                deny: Some(vec!["Bash".to_string()]),
                default_mode: Some("acceptEdits".to_string()),
            }),
            skip_dangerous: Some(true),
            mcp_servers: Some(HashMap::new()),
            system_instructions: Some("You are a coding assistant".to_string()),
            global_memory: Some("remember the user's preferences".to_string()),
            context_compaction: Some(ContextCompaction {
                threshold: Some(0.85),
                method: Some("summary".to_string()),
            }),
            verbose: Some(false),
            max_turns: Some(20),
            theme: Some("dark".to_string()),
        };

        let value = serde_json::to_value(cfg.clone()).unwrap();
        let restored: JishuConfig = serde_json::from_value(value).unwrap();
        assert_eq!(restored.active_model, cfg.active_model);
        assert_eq!(restored.temperature, cfg.temperature);
        assert_eq!(
            restored.permissions.unwrap().default_mode,
            Some("acceptEdits".to_string())
        );
    }

    #[test]
    fn jishu_config_camel_case_field_names() {
        let value = serde_json::to_value(JishuConfig {
            active_model: Some("gpt-4".to_string()),
            max_tokens: Some(4096),
            thinking_enabled: Some(true),
            skip_dangerous: Some(false),
            system_instructions: Some("hi".to_string()),
            global_memory: Some("mem".to_string()),
            context_compaction: Some(ContextCompaction {
                threshold: Some(0.5),
                method: Some("truncate".to_string()),
            }),
            max_turns: Some(10),
            ..Default::default()
        })
        .unwrap();
        let obj = value.as_object().unwrap();
        assert!(obj.contains_key("activeModel"));
        assert!(obj.contains_key("maxTokens"));
        assert!(obj.contains_key("thinkingEnabled"));
        assert!(obj.contains_key("skipDangerous"));
        assert!(obj.contains_key("systemInstructions"));
        assert!(obj.contains_key("globalMemory"));
        assert!(obj.contains_key("contextCompaction"));
        assert!(obj.contains_key("maxTurns"));
        assert!(!obj.contains_key("active_model"));
    }

    #[test]
    fn jishu_permissions_camel_case() {
        let value = serde_json::to_value(JishuPermissions {
            allow: Some(vec![]),
            deny: None,
            default_mode: Some("plan".to_string()),
        })
        .unwrap();
        let obj = value.as_object().unwrap();
        assert!(obj.contains_key("defaultMode"));
        assert!(!obj.contains_key("default_mode"));
    }
}
