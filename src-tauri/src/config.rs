use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

fn deserialize_flex_env<'de, D>(
    deserializer: D,
) -> Result<Option<HashMap<String, String>>, D::Error>
where
    D: Deserializer<'de>,
{
    let opt: Option<HashMap<String, serde_json::Value>> = Option::deserialize(deserializer)?;
    Ok(opt.map(|map| {
        map.into_iter()
            .map(|(k, v)| {
                let s = match v {
                    serde_json::Value::String(s) => s,
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::Bool(b) => b.to_string(),
                    other => other.to_string(),
                };
                (k, s)
            })
            .collect()
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionsConfig {
    pub allow: Option<Vec<String>>,
    pub deny: Option<Vec<String>>,
    #[serde(rename = "defaultMode")]
    pub default_mode: Option<String>,
    #[serde(rename = "additionalDirectories")]
    pub additional_directories: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub server_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// HTTP headers (e.g. Authorization) for url-based MCP servers.
    /// pi-mcp-adapter supports ${ENV_VAR} and $env:ENV_VAR interpolation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookAction {
    #[serde(rename = "type")]
    pub action_type: String,
    pub command: Option<String>,
    pub timeout: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookMatcher {
    pub matcher: Option<String>,
    pub hooks: Vec<HookAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxConfig {
    pub enabled: Option<bool>,
    #[serde(rename = "allowCommand")]
    pub allow_command: Option<Vec<String>>,
    #[serde(rename = "denyCommand")]
    pub deny_command: Option<Vec<String>>,
    #[serde(rename = "allowPath")]
    pub allow_path: Option<Vec<String>>,
    #[serde(rename = "denyPath")]
    pub deny_path: Option<Vec<String>>,
    pub network: Option<String>,
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextCompactionConfig {
    pub threshold: Option<f64>,
    pub method: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClaudeConfig {
    pub model: Option<String>,
    /// 推理力度（v0.7.4 需求4 B1：codex 的 model_reasoning_effort 映射；
    /// claude/opencode 不使用，序列化为 null 时由各 adapter 自行取舍）。
    #[serde(
        rename = "reasoningEffort",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub reasoning_effort: Option<String>,
    /// 自定义模型供应商（v0.7.4 R12：opencode 的 provider.<id> 段
    ///（name/npm/options/models），UI 全量带回、未知键保留；仅 opencode 使用）。
    #[serde(
        rename = "customProviders",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub custom_providers: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(deserialize_with = "deserialize_flex_env")]
    pub env: Option<HashMap<String, String>>,
    #[serde(rename = "enabledPlugins")]
    pub enabled_plugins: Option<HashMap<String, bool>>,
    #[serde(rename = "skipDangerousModePermissionPrompt")]
    pub skip_dangerous: Option<bool>,

    #[serde(rename = "cleanupPeriodDays")]
    pub cleanup_period_days: Option<serde_json::Value>,

    #[serde(rename = "extraKnownMarketplaces")]
    pub extra_known_marketplaces: Option<serde_json::Value>,

    pub theme: Option<String>,

    #[serde(rename = "permissions")]
    pub permissions: Option<PermissionsConfig>,

    #[serde(rename = "mcpServers")]
    pub mcp_servers: Option<std::collections::HashMap<String, McpServerConfig>>,

    #[serde(rename = "apiProvider")]
    pub api_provider: Option<String>,

    #[serde(rename = "smallModel")]
    pub small_model: Option<String>,

    #[serde(rename = "largeModel")]
    pub large_model: Option<String>,

    #[serde(rename = "allowedTools")]
    pub allowed_tools: Option<Vec<String>>,

    #[serde(rename = "disallowedTools")]
    pub disallowed_tools: Option<Vec<String>>,

    #[serde(rename = "hooks")]
    pub hooks: Option<std::collections::HashMap<String, Vec<HookMatcher>>>,

    #[serde(rename = "sandbox")]
    pub sandbox: Option<SandboxConfig>,

    #[serde(rename = "verbose")]
    pub verbose: Option<bool>,

    #[serde(rename = "maxTurns")]
    pub max_turns: Option<u64>,

    #[serde(rename = "contextCompaction")]
    pub context_compaction: Option<ContextCompactionConfig>,

    /// codex 顶层 model_provider（v0.7.5 需求7：直连/中转切换——选中的
    /// model_providers 条目 id；None = 官方直连）。仅 codex 使用（联合结构
    /// 渐进路线，per-agent 拆分见 v0.7.4 审查 A3）。
    #[serde(
        rename = "modelProvider",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub model_provider: Option<String>,

    /// codex `[model_providers.*]` 表（键为 codex 原生：name/base_url/
    /// wire_api/env_key；wire_api 固定 "responses"——Responses API 兼容端点
    /// 才可接入，官方/DeepSeek/智谱 Coding Plan 均已官方支持）。仅 codex 使用。
    #[serde(
        rename = "modelProviders",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub model_providers: Option<std::collections::BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupEntry {
    pub name: String,
    pub path: String,
    pub timestamp: Option<String>,
}

pub fn claude_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    Ok(home.join(".claude"))
}

pub fn config_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(claude_dir()?.join("settings.json"))
}

pub fn load_config() -> Result<ClaudeConfig, Box<dyn std::error::Error>> {
    let path = config_path()?;
    let content = std::fs::read_to_string(&path)?;
    let config: ClaudeConfig = serde_json::from_str(&content)?;
    Ok(config)
}

pub fn save_config(config: &ClaudeConfig) -> Result<(), Box<dyn std::error::Error>> {
    let path = config_path()?;
    backup_config()?;

    let existing = if path.exists() {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str::<serde_json::Value>(&content).ok()
    } else {
        None
    };

    let mut new_value = serde_json::to_value(config).map_err(|e| e.to_string())?;

    // Remove null values — don't write keys that have no configured value
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
    let _: ClaudeConfig = serde_json::from_str(&written)?;
    Ok(())
}

/// Claude Code 的 user-scope MCP 权威文件：`~/.claude.json`（非 settings.json——
/// settings.json 的 mcpServers 不被 Claude Code 加载，v0.9.0 需求20 第二轮
/// 根因修复：一期注入写错文件导致 agent 无法发现 jishu-hub）。
pub fn claude_user_config_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    Ok(home.join(".claude.json"))
}

/// ~/.claude.json 整文件 Value 读写（备份 + 原子写；文件是 Claude Code 的
/// 状态存储，仅经 mcp_inject 的 mcpServers 键级修改，其余键原样保留）。
pub fn load_claude_user_config_value() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let path = claude_user_config_path()?;
    if !path.exists() {
        return Ok(serde_json::Value::Object(Default::default()));
    }
    let content = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&content)?)
}

pub fn save_claude_user_config_value(
    value: &serde_json::Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let path = claude_user_config_path()?;
    // 备份到 ~/.claude/backups/（复用既有目录与清理策略）。
    if let Ok(backup_dir) = claude_dir().map(|d| d.join("backups")) {
        let _ = std::fs::create_dir_all(&backup_dir);
        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        if path.exists() {
            let _ = std::fs::copy(&path, backup_dir.join(format!("userconfig_{timestamp}.json")));
        }
        let _ = cleanup_old_backups(&backup_dir, 10);
    }
    let content = serde_json::to_string_pretty(value)?;
    crate::util::atomic_write(&path, content.as_bytes())?;
    Ok(())
}

pub fn backup_config() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = claude_dir()?;
    let backup_dir = dir.join("backups");
    std::fs::create_dir_all(&backup_dir)?;
    let src = dir.join("settings.json");
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let dst = backup_dir.join(format!("settings_{}.json", timestamp));
    if src.exists() {
        std::fs::copy(&src, &dst)?;
    }
    cleanup_old_backups(&backup_dir, 10)?;
    Ok(dst)
}

fn cleanup_old_backups(
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

pub fn list_backups() -> Result<Vec<BackupEntry>, Box<dyn std::error::Error>> {
    let backup_dir = claude_dir()?.join("backups");
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

pub fn restore_backup(backup_path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let dst = config_path()?;
    let content = std::fs::read_to_string(backup_path)?;
    let _: ClaudeConfig = serde_json::from_str(&content)?;
    crate::util::atomic_write(&dst, content.as_bytes())?;
    Ok(())
}

pub fn export_config(export_path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let src = config_path()?;
    let content = std::fs::read_to_string(&src)?;
    crate::util::atomic_write(std::path::Path::new(export_path), content.as_bytes())?;
    Ok(())
}

pub fn import_config(import_path: &str) -> Result<ClaudeConfig, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(import_path)?;
    let config: ClaudeConfig = serde_json::from_str(&content)?;
    let dst = config_path()?;
    backup_config()?;
    crate::util::atomic_write(&dst, content.as_bytes())?;
    Ok(config)
}
