use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Permissions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hooks: Option<HashMap<String, Vec<HookEntry>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 默认思考档位（v0.7.4 项目配置适配：jishu 的 defaultThinkingLevel；
    /// claude 等无此概念的 agent 忽略——skip_serializing_if 保证不落盘）。
    #[serde(
        rename = "thinkingLevel",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub thinking_level: Option<String>,
    /// 上下文压缩设置（jishu 的 compaction；Pi 真实字段。claude 忽略）。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub compaction: Option<ProjectCompaction>,
}

/// Pi CompactionSettings（settings-manager.ts，jishu v0.84.2-10：阈值改按
/// 窗口百分比，替代绝对 reserveTokens）。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ProjectCompaction {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub enabled: Option<bool>,
    #[serde(
        rename = "thresholdPercent",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub threshold_percent: Option<u64>,
    #[serde(
        rename = "keepRecentTokens",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub keep_recent_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Permissions {
    #[serde(rename = "defaultMode", skip_serializing_if = "Option::is_none")]
    pub default_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deny: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    pub hooks: Vec<HookCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookCommand {
    #[serde(rename = "type")]
    pub hook_type: String,
    pub command: String,
}

fn settings_path(project_path: &str) -> PathBuf {
    PathBuf::from(project_path)
        .join(".claude")
        .join("settings.json")
}

fn settings_local_path(project_path: &str) -> PathBuf {
    PathBuf::from(project_path)
        .join(".claude")
        .join("settings.local.json")
}

fn ensure_claude_dir(project_path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let dir = PathBuf::from(project_path).join(".claude");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    Ok(())
}

pub fn load_project_settings(
    project_path: &str,
) -> Result<ProjectSettings, Box<dyn std::error::Error>> {
    let path = settings_path(project_path);
    if !path.exists() {
        return Ok(ProjectSettings::default());
    }
    let content = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&content)?)
}

pub fn load_project_settings_local(
    project_path: &str,
) -> Result<ProjectSettings, Box<dyn std::error::Error>> {
    let path = settings_local_path(project_path);
    if !path.exists() {
        return Ok(ProjectSettings::default());
    }
    let content = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&content)?)
}

pub fn save_project_settings(
    project_path: &str,
    settings: &ProjectSettings,
) -> Result<(), Box<dyn std::error::Error>> {
    ensure_claude_dir(project_path)?;
    let path = settings_path(project_path);
    let mut val = serde_json::to_value(settings)?;
    if let Some(obj) = val.as_object_mut() {
        obj.retain(|_, v| !v.is_null());
    }
    crate::util::atomic_write(&path, serde_json::to_string_pretty(&val)?.as_bytes())?;
    Ok(())
}

pub fn save_project_settings_local(
    project_path: &str,
    settings: &ProjectSettings,
) -> Result<(), Box<dyn std::error::Error>> {
    ensure_claude_dir(project_path)?;
    let path = settings_local_path(project_path);
    let mut val = serde_json::to_value(settings)?;
    if let Some(obj) = val.as_object_mut() {
        obj.retain(|_, v| !v.is_null());
    }
    crate::util::atomic_write(&path, serde_json::to_string_pretty(&val)?.as_bytes())?;
    Ok(())
}

pub fn load_claude_md(project_path: &str) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let path = PathBuf::from(project_path)
        .join(".claude")
        .join("CLAUDE.md");
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path)?;
    Ok(Some(content))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deserialize_project_settings() {
        let json = r#"{"permissions":{"defaultMode":"bypassPermissions","allow":["Bash(cargo build)","Bash(cargo test)"]}}"#;
        let settings: ProjectSettings = serde_json::from_str(json).unwrap();
        assert!(settings.permissions.is_some());
        let perms = settings.permissions.unwrap();
        assert_eq!(perms.default_mode, Some("bypassPermissions".to_string()));
        assert_eq!(perms.allow.unwrap().len(), 2);
    }

    #[test]
    fn test_roundtrip_serialization() {
        let json =
            r#"{"permissions":{"defaultMode":"bypassPermissions","allow":["Bash(cargo build)"]}}"#;
        let settings: ProjectSettings = serde_json::from_str(json).unwrap();
        let reserialized = serde_json::to_string(&settings).unwrap();
        assert!(reserialized.contains("\"defaultMode\":\"bypassPermissions\""));
    }

    #[test]
    fn test_serialize_to_frontend_format() {
        let json =
            r#"{"permissions":{"defaultMode":"bypassPermissions","allow":["Bash(cargo build)"]}}"#;
        let settings: ProjectSettings = serde_json::from_str(json).unwrap();
        let output = serde_json::to_value(&settings).unwrap();
        let perms = output.get("permissions").unwrap();
        assert_eq!(
            perms.get("defaultMode").unwrap().as_str(),
            Some("bypassPermissions")
        );
    }
}
