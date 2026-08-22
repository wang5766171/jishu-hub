use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::config::{BackupEntry, McpServerConfig};

/// Pi RetrySettings（settings-manager.ts:29-34）中与行为页相关的子集。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PiRetrySettings {
    pub enabled: Option<bool>,
    pub max_retries: Option<u32>,
    #[serde(
        rename = "baseDelayMs",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub base_delay_ms: Option<u64>,
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
    /// v0.7.5：补回 Pi schema 中行为相关的真实字段 compaction/defaultTools/
    /// retry（R15 只保留了 defaultThinkingLevel，行为页设置项不完整）；
    /// 移除死字段 contextCompaction 与 env/systemInstructions/globalMemory
    ///（v0.7.4 审查 C1：经 Pi settings schema 复核确认均不存在，历史键
    /// 原样保留、Pi 忽略）。
    #[serde(
        rename = "defaultThinkingLevel",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub default_thinking_level: Option<String>,

    /// Pi CompactionSettings：全局默认上下文压缩策略（项目级深合并覆盖）。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub compaction: Option<crate::project_config::ProjectCompaction>,

    /// Pi defaultTools：初始激活的内置工具集（全集 read/bash/edit/write/
    /// grep/find/ls；未设置时 Pi 默认 read/bash/edit/write）。
    #[serde(
        rename = "defaultTools",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub default_tools: Option<Vec<String>>,

    /// Pi RetrySettings：模型请求失败重试策略。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub retry: Option<PiRetrySettings>,

    pub mcp_servers: Option<HashMap<String, McpServerConfig>>,

    pub theme: Option<String>,
}

fn jishu_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    super::paths::agent_dir()
}

pub fn jishu_config_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    super::paths::settings_path()
}

fn jishu_backup_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    super::paths::backups_dir()
}

/// Sync mcpServers from JishuConfig to ~/.jishu-agent/mcp.json.
/// pi-mcp-adapter reads MCP server definitions from <Pi agent dir>/mcp.json,
/// not from settings.json's mcpServers field.
pub fn sync_mcp_json(config: &JishuConfig) -> Result<(), Box<dyn std::error::Error>> {
    let mcp_path = super::paths::mcp_json_path()?;

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

/// Pi 原生项目级设置：`<project>/.jishu-agent/settings.json`（深合并覆盖全局；
/// 字段为 Pi Settings schema：defaultModel / defaultThinkingLevel 等，
/// 不含 permissions/env——行为参数块那些字段 Pi 并不读取）。
///
/// 路径依据：fork 的 `piConfig.configDir = ".jishu-agent"`（package.json），
/// Pi `FileSettingsStorage` 取 `join(cwd, CONFIG_DIR_NAME, "settings.json")`
///（settings-manager.js:47）。v0.7.4 R16 误按上游 `.pi` 目录名核查，
/// 写入目录 Pi 从未读取（v0.7.5 需求3 修正，不留兼容）。
pub fn pi_project_settings_path(project_path: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(std::path::Path::new(project_path)
        .join(".jishu-agent")
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

/// 写项目 .jishu-agent/settings.json：只改 defaultModel / defaultThinkingLevel /
/// compaction 三组键，其余（含用户手写的 Pi 字段）原样保留；null = 删除该键。
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
        .ok_or("project settings.json must be an object")?;
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
    let mut value: serde_json::Value = serde_json::from_str(&content).map_err(|e| {
        format!(
            "Failed to parse {}: {}",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("settings.json"),
            e
        )
    })?;
    // 返回「有效配置视图」：剔除死键（含历史残留），行为页/高级设置/模版
    // 快照看到的都是真实生效的字段；文件中的残留待下次保存时落盘清除。
    strip_dead_keys(&mut value);
    Ok(value)
}

/// Pi Settings schema 中不存在的死键（R15 + 需求2 C1 逐一经
/// settings-manager.ts 核实）：旧版 UI 误写入或旧结构体残留，Pi 从不读取。
/// 保存时主动剔除（v0.7.5 需求4：模版快照与应用模版都会经此清理，
/// 历史 settings.json 中的残留随任一次 GUI 保存自然清除）。
const KNOWN_DEAD_KEYS: &[&str] = &[
    // v0.7.4 R15 整改清单
    "activeModel",
    "temperature",
    "maxTokens",
    "thinkingEnabled",
    "permissions",
    "skipDangerous",
    "skipDangerousModePermissionPrompt",
    "verbose",
    "maxTurns",
    // v0.7.5 需求2 C1 复核追加
    "env",
    "systemInstructions",
    "globalMemory",
    "contextCompaction",
];

/// 从配置 JSON 对象中就地剔除死键（load 的「有效配置视图」用）。
fn strip_dead_keys(value: &mut serde_json::Value) {
    if let Some(obj) = value.as_object_mut() {
        for key in KNOWN_DEAD_KEYS {
            obj.remove(*key);
        }
    }
}

/// 键级覆盖合并（v0.7.5 修复「恢复默认无法保存」）：
/// 前端 save_config 只传变更键（思考档位/压缩/工具/重试/MCP 各自独立保存），
/// patch 中显式 `null` = 从落盘对象删除该键（恢复 Pi 默认），非 null = 写入/
/// 整组替换，未提及的键保留 existing 原值。此前实现把「null 删除」误当成
/// 「未提及」从 existing 恢复旧值，导致行为页选「默认」永远存不上。
/// 合并前后均剔除 KNOWN_DEAD_KEYS（含 patch 中出现的——应用带死键的旧
/// 模版同样免疫）。
fn merge_config_patch(
    existing: Option<serde_json::Map<String, serde_json::Value>>,
    patch: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut merged = existing.unwrap_or_default();
    for key in KNOWN_DEAD_KEYS {
        merged.remove(*key);
    }
    for (key, value) in patch {
        if KNOWN_DEAD_KEYS.contains(&key.as_str()) {
            continue;
        }
        if value.is_null() {
            merged.remove(key);
        } else {
            merged.insert(key.clone(), value.clone());
        }
    }
    merged
}

pub fn save_jishu_config(config: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
    let patch = config
        .as_object()
        .ok_or("config must be a JSON object for key-level patching")?;
    let path = jishu_config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    backup_jishu_config()?;

    let existing = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .and_then(|v| v.as_object().cloned())
    } else {
        None
    };

    let merged = merge_config_patch(existing, patch);

    // 校验合并结果仍可解析为 JishuConfig（未知键忽略；类型错配在此暴露），
    // 并提取 typed 用于 mcp.json 同步。
    let typed: JishuConfig = serde_json::from_value(serde_json::to_value(&merged)?)?;

    let json = serde_json::to_string_pretty(&merged)?;
    crate::util::atomic_write(&path, json.as_bytes())?;

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
                threshold_percent: Some(90),
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
        assert_eq!(raw["compaction"]["thresholdPercent"], serde_json::json!(90));
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
        // R15 死字段整改 + v0.7.5 补全/清理后：真实字段 = defaultThinkingLevel /
        // compaction / defaultTools / retry / mcpServers / theme（env/
        // systemInstructions/globalMemory/contextCompaction 均已核实为死字段删除）。
        let cfg = JishuConfig {
            default_thinking_level: Some("high".to_string()),
            compaction: Some(crate::project_config::ProjectCompaction {
                enabled: Some(false),
                threshold_percent: Some(90),
                keep_recent_tokens: Some(20000),
            }),
            default_tools: Some(vec![
                "read".to_string(),
                "bash".to_string(),
                "edit".to_string(),
                "write".to_string(),
                "grep".to_string(),
            ]),
            retry: Some(PiRetrySettings {
                enabled: Some(true),
                max_retries: Some(5),
                base_delay_ms: Some(2000),
            }),
            mcp_servers: Some(HashMap::new()),
            theme: Some("dark".to_string()),
        };
        let value = serde_json::to_value(cfg.clone()).unwrap();
        let restored: JishuConfig = serde_json::from_value(value).unwrap();
        assert_eq!(restored.default_thinking_level, cfg.default_thinking_level);
        assert_eq!(restored.compaction, cfg.compaction);
        assert_eq!(restored.default_tools, cfg.default_tools);
        assert_eq!(
            restored.retry.unwrap().enabled,
            cfg.retry.as_ref().unwrap().enabled
        );
        assert_eq!(restored.theme, cfg.theme);
    }

    #[test]
    fn jishu_config_camel_case_field_names() {
        let value = serde_json::to_value(JishuConfig {
            default_thinking_level: Some("low".to_string()),
            default_tools: Some(vec!["read".to_string()]),
            compaction: Some(crate::project_config::ProjectCompaction {
                enabled: Some(true),
                threshold_percent: Some(85),
                keep_recent_tokens: None,
            }),
            retry: Some(PiRetrySettings {
                enabled: None,
                max_retries: Some(3),
                base_delay_ms: None,
            }),
            ..Default::default()
        })
        .unwrap();
        let obj = value.as_object().unwrap();
        assert!(obj.contains_key("defaultThinkingLevel"));
        assert!(obj.contains_key("defaultTools"));
        assert!(obj.contains_key("compaction"));
        assert!(obj.contains_key("retry"));
        assert!(obj.contains_key("theme"));
        assert!(!obj.contains_key("default_thinking_level"));
        assert!(!obj.contains_key("contextCompaction"));
        assert!(!obj.contains_key("systemInstructions"));
        assert!(!obj.contains_key("globalMemory"));
        assert!(!obj.contains_key("env"));
    }

    #[test]
    fn merge_config_patch_null_deletes_and_unmentioned_preserved() {
        // v0.7.5「恢复默认无法保存」回归锁定：null 必须删除键，而非从
        // existing 恢复；未提及键原样保留（含 Pi/用户手写的未知键）；
        // 已知死键（v0.7.4 旧 UI 写入的 permissions 等）无论来自 existing
        // 还是 patch 一律剔除。
        let existing = serde_json::json!({
            "defaultThinkingLevel": "low",
            "compaction": { "enabled": false },
            "extensions": ["extensions/jishu-task-conductor.ts"],
            "theme": "dark",
            "permissions": { "defaultMode": "bypassPermissions" },
            "temperature": 0.7
        });
        let merged = merge_config_patch(
            existing.as_object().cloned(),
            serde_json::json!({ "defaultThinkingLevel": null, "compaction": { "enabled": true, "reserveTokens": 16384 }, "env": { "FOO": "bar" } })
                .as_object()
                .unwrap(),
        );
        let merged = serde_json::Value::Object(merged);
        assert!(merged.get("defaultThinkingLevel").is_none(), "null deletes");
        assert_eq!(merged["compaction"]["enabled"], serde_json::json!(true));
        assert_eq!(
            merged["compaction"]["reserveTokens"],
            serde_json::json!(16384)
        );
        assert_eq!(
            merged["extensions"],
            serde_json::json!(["extensions/jishu-task-conductor.ts"])
        );
        assert_eq!(merged["theme"], serde_json::json!("dark"));
        assert!(
            merged.get("permissions").is_none(),
            "dead key purged from existing"
        );
        assert!(merged.get("temperature").is_none());
        assert!(
            merged.get("env").is_none(),
            "dead key in patch never written"
        );
    }

    #[test]
    fn strip_dead_keys_builds_effective_view() {
        // load_config 的「有效配置视图」：死键（含历史残留）不出现在 UI/
        // 模版快照中；活键（Pi schema 字段与用户手写键）原样保留。
        let mut value = serde_json::json!({
            "defaultThinkingLevel": "medium",
            "permissions": { "defaultMode": "bypassPermissions" },
            "temperature": 0.7,
            "extensions": ["extensions/session-context.ts"],
            "theme": "dark"
        });
        strip_dead_keys(&mut value);
        assert!(value.get("permissions").is_none());
        assert!(value.get("temperature").is_none());
        assert_eq!(value["defaultThinkingLevel"], serde_json::json!("medium"));
        assert_eq!(
            value["extensions"],
            serde_json::json!(["extensions/session-context.ts"])
        );
        assert_eq!(value["theme"], serde_json::json!("dark"));
    }
}
