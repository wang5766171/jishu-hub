//! jishu-hub's own settings file, separate from Pi's config.
//!
//! Lives at `~/.jishu-hub/settings.json`. Currently holds:
//! - `active`: the (provider, model) pair jishu uses when launching Pi.
//!   This is a jishu concept; Pi doesn't have an "active model" —
//!   it's invoked with `--provider/--model` CLI args each time, so
//!   Pi's own state file is left alone.
//!
//! Anything else jishu needs to remember between sessions can hang
//! off this struct without polluting Pi's `~/.jishu-agent/` tree.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JishuSettings {
    /// The provider+model pair the user picked in the GUI. Pi is
    /// launched with `--provider <active.provider> --model
    /// <active.model>` whenever a new session starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<ActiveModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActiveModel {
    pub provider: String,
    pub model: String,
}

pub fn default_settings_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot find home directory".to_string())?;
    Ok(home.join(".jishu-hub").join("settings.json"))
}

pub fn load() -> Result<JishuSettings, String> {
    load_from(&default_settings_path()?)
}

pub fn load_from(path: &Path) -> Result<JishuSettings, String> {
    if !path.exists() {
        return Ok(JishuSettings::default());
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Cannot read settings.json at {}: {e}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(JishuSettings::default());
    }
    serde_json::from_str(&content)
        .map_err(|e| format!("Cannot parse settings.json at {}: {e}", path.display()))
}

pub fn save(settings: &JishuSettings) -> Result<(), String> {
    save_to(&default_settings_path()?, settings)
}

pub fn save_to(path: &Path, settings: &JishuSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create directory {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Cannot serialize settings.json: {e}"))?;
    fs::write(path, format!("{json}\n"))
        .map_err(|e| format!("Cannot write settings.json to {}: {e}", path.display()))?;
    Ok(())
}

pub fn get_active() -> Result<Option<ActiveModel>, String> {
    Ok(load()?.active)
}

pub fn set_active(active: Option<ActiveModel>) -> Result<(), String> {
    let mut settings = load()?;
    settings.active = active;
    save(&settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_tmp(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "jishu_settings_{label}_{}_{}_{}",
            std::process::id(),
            id,
            nanos
        ))
    }

    #[test]
    fn load_missing_returns_default() {
        let dir = unique_tmp("missing");
        let path = dir.join("settings.json");
        let s = load_from(&path).unwrap();
        assert!(s.active.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_and_get_active_roundtrips() {
        let dir = unique_tmp("active");
        let path = dir.join("settings.json");
        let active = ActiveModel {
            provider: "zhipu".to_string(),
            model: "glm-5.1".to_string(),
        };
        let settings = JishuSettings {
            active: Some(active.clone()),
        };
        save_to(&path, &settings).unwrap();

        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded.active, Some(active));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_active_field_is_treated_as_none() {
        let dir = unique_tmp("noactive");
        let path = dir.join("settings.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{}\n").unwrap();
        let loaded = load_from(&path).unwrap();
        assert!(loaded.active.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clearing_active_persists_as_null() {
        let dir = unique_tmp("clear");
        let path = dir.join("settings.json");
        let mut settings = JishuSettings {
            active: Some(ActiveModel {
                provider: "zhipu".to_string(),
                model: "glm-5.1".to_string(),
            }),
        };
        save_to(&path, &settings).unwrap();
        settings.active = None;
        save_to(&path, &settings).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("\"active\""),
            "active field should be skipped when None, raw = {raw}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
