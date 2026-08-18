//! Read/write `~/.jishu-agent/models.json` — the file Pi itself reads on startup.
//!
//! The schema is a faithful mirror of Pi's `ModelsConfigSchema` (see
//! `third_party/pi/packages/coding-agent/src/core/model-registry.ts:533-558`).
//! Fields use camelCase to match Pi's wire format so whatever we write is
//! exactly what Pi will parse.
//!
//! Layout:
//! - `PiModelsConfig { providers: BTreeMap<String, PiProviderConfig> }`
//! - `PiProviderConfig` mirrors Pi's `ProviderConfigSchema`
//! - `PiModelDefinition` mirrors Pi's `ModelDefinitionSchema`
//! - `compat` is kept as `serde_json::Value` because Pi uses a TypeBox
//!   union for it (ProviderCompat) and the exact shape depends on the
//!   chosen `api`. Round-tripping as raw JSON preserves it exactly.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Top-level `models.json` shape.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PiModelsConfig {
    #[serde(default)]
    pub providers: BTreeMap<String, PiProviderConfig>,
}

/// One provider entry. Field names match Pi's wire format exactly
/// (camelCase), so the serialized JSON is byte-for-byte compatible
/// with what `pi --provider <name> --model <id>` expects to find.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PiProviderConfig {
    #[serde(rename = "name", skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,

    #[serde(rename = "baseUrl", skip_serializing_if = "Option::is_none", default)]
    pub base_url: Option<String>,

    #[serde(rename = "apiKey", skip_serializing_if = "Option::is_none", default)]
    pub api_key: Option<String>,

    #[serde(rename = "api", skip_serializing_if = "Option::is_none", default)]
    pub api: Option<String>,

    #[serde(rename = "headers", skip_serializing_if = "Option::is_none", default)]
    pub headers: Option<BTreeMap<String, String>>,

    /// Kept as raw JSON to preserve whatever shape Pi's ProviderCompat
    /// union expects (depends on `api`). jishu never edits this directly
    /// — it's round-tripped as-is.
    #[serde(rename = "compat", skip_serializing_if = "Option::is_none", default)]
    pub compat: Option<serde_json::Value>,

    #[serde(
        rename = "authHeader",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub auth_header: Option<bool>,

    #[serde(rename = "models", skip_serializing_if = "Option::is_none", default)]
    pub models: Option<Vec<PiModelDefinition>>,

    #[serde(
        rename = "modelOverrides",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub model_overrides: Option<BTreeMap<String, PiModelOverride>>,
}

impl PiProviderConfig {
    /// Empty provider — used when the GUI is creating a new one.
    pub fn new() -> Self {
        Self::default()
    }
}

/// One model entry inside `provider.models[]`. camelCase fields to match
/// Pi's `ModelDefinitionSchema`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiModelDefinition {
    pub id: String,
    pub name: String,

    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub api: Option<String>,

    #[serde(rename = "baseUrl", skip_serializing_if = "Option::is_none", default)]
    pub base_url: Option<String>,

    pub reasoning: bool,

    #[serde(
        rename = "thinkingLevelMap",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub thinking_level_map: Option<serde_json::Value>,

    /// "text" / "image" — input modalities the model supports.
    pub input: Vec<String>,

    pub cost: PiModelCost,

    #[serde(rename = "contextWindow")]
    pub context_window: u64,

    #[serde(rename = "maxTokens")]
    pub max_tokens: u64,

    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub headers: Option<BTreeMap<String, String>>,

    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub compat: Option<serde_json::Value>,
}

/// Per-model cost in USD per million tokens. All four fields are
/// always serialized, even when zero — Pi's TypeBox schema requires
/// all four to be present, so we cannot skip them on serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiModelCost {
    pub input: f64,
    pub output: f64,
    #[serde(rename = "cacheRead")]
    pub cache_read: f64,
    #[serde(rename = "cacheWrite")]
    pub cache_write: f64,
}

impl Default for PiModelCost {
    fn default() -> Self {
        Self {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
        }
    }
}

/// Per-model override (keyed by model id within a provider's
/// `modelOverrides` map).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PiModelOverride {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reasoning: Option<bool>,

    #[serde(
        rename = "thinkingLevelMap",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub thinking_level_map: Option<serde_json::Value>,

    pub input: Option<Vec<String>>,

    pub cost: Option<PiModelCost>,

    #[serde(
        rename = "contextWindow",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub context_window: Option<u64>,

    #[serde(rename = "maxTokens", skip_serializing_if = "Option::is_none", default)]
    pub max_tokens: Option<u64>,

    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub headers: Option<BTreeMap<String, String>>,

    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub compat: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/// Default `models.json` path. Pi reads from `getAgentDir()/models.json`,
/// and we set `PI_CODING_AGENT_DIR` to `~/.jishu-agent` when spawning Pi,
/// so the agent dir becomes `~/.jishu-agent/` and models lives here.
pub fn default_models_path() -> Result<PathBuf, String> {
    super::paths::models_path().map_err(|e| e.to_string())
}

pub fn load() -> Result<PiModelsConfig, String> {
    load_from(&default_models_path()?)
}

pub fn load_from(path: &Path) -> Result<PiModelsConfig, String> {
    if !path.exists() {
        return Ok(PiModelsConfig::default());
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Cannot read models.json at {}: {e}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(PiModelsConfig::default());
    }
    let config: PiModelsConfig = serde_json::from_str(&content)
        .map_err(|e| format!("Cannot parse models.json at {}: {e}", path.display()))?;
    Ok(config)
}

pub fn save(config: &PiModelsConfig) -> Result<(), String> {
    save_to(&default_models_path()?, config)
}

pub fn save_to(path: &Path, config: &PiModelsConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create directory {}: {e}", parent.display()))?;
    }
    // v0.7.4：渠道配置（apiKey/名称等）落盘前自动备份旧 models.json，
    // 与 settings.json 的自动备份同一目录（<agent>/backups）、同一保留策略。
    backup_models_file(path)?;
    // 2-space indent matches Pi's own JSON style and keeps diffs
    // against Pi-authored models.json readable.
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Cannot serialize models.json: {e}",))?;
    fs::write(path, format!("{json}\n"))
        .map_err(|e| format!("Cannot write models.json to {}: {e}", path.display()))?;
    Ok(())
}

/// 备份已存在的 models.json 到同目录 backups/models_<时间戳>.json，
/// 保留最近 10 份；文件不存在（首次配置）时不产生备份。
fn backup_models_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let backup_dir = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backups");
    fs::create_dir_all(&backup_dir).map_err(|e| {
        format!(
            "Cannot create backup directory {}: {e}",
            backup_dir.display()
        )
    })?;
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let dst = backup_dir.join(format!("models_{timestamp}.json"));
    fs::copy(path, &dst).map_err(|e| {
        format!(
            "Cannot back up models.json {} -> {}: {e}",
            path.display(),
            dst.display()
        )
    })?;
    cleanup_old_models_backups(&backup_dir, 10);
    Ok(())
}

fn cleanup_old_models_backups(backup_dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(backup_dir) else {
        return;
    };
    let mut backups: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext == "json")
                .unwrap_or(false)
                && e.file_name().to_string_lossy().starts_with("models_")
        })
        .map(|e| e.path())
        .collect();
    if backups.len() <= keep {
        return;
    }
    backups.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    for old in backups.iter().skip(keep) {
        let _ = fs::remove_file(old);
    }
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

pub fn upsert_provider(name: &str, provider: PiProviderConfig) -> Result<(), String> {
    let mut config = load()?;
    config.providers.insert(name.to_string(), provider);
    save(&config)
}

pub fn delete_provider(name: &str) -> Result<bool, String> {
    let mut config = load()?;
    let removed = config.providers.remove(name).is_some();
    if removed {
        save(&config)?;
    }
    Ok(removed)
}

pub fn get_provider(name: &str) -> Result<Option<PiProviderConfig>, String> {
    Ok(load()?.providers.remove(name))
}

pub fn list_providers() -> Result<Vec<(String, PiProviderConfig)>, String> {
    Ok(load()?.providers.into_iter().collect())
}

/// 由渠道 + 模型条目构造最小连通性测试用的 ModelPreset（GUI test_model
/// 与 CLI `agent model test` 共用）：模型级 api/baseUrl 覆盖渠道级，
/// 协议缺省 anthropic-messages，密钥取渠道级 apiKey。
pub fn to_test_preset(
    provider: &str,
    provider_cfg: &PiProviderConfig,
    model: &PiModelDefinition,
) -> Result<crate::llm::config::ModelPreset, String> {
    let api = model
        .api
        .as_deref()
        .or(provider_cfg.api.as_deref())
        .unwrap_or("anthropic-messages");
    let base_url = model
        .base_url
        .as_deref()
        .or(provider_cfg.base_url.as_deref())
        .unwrap_or("");
    if base_url.trim().is_empty() {
        return Err(format!("Provider '{provider}' has no base URL configured"));
    }
    Ok(crate::llm::config::ModelPreset {
        id: format!("{provider}/{}", model.id),
        display_name: model.name.clone(),
        protocol: crate::llm::config::protocol_for_pi_api(api)?.to_string(),
        base_url: base_url.to_string(),
        model: model.id.clone(),
        api_key: provider_cfg
            .api_key
            .clone()
            .filter(|k| !k.trim().is_empty()),
        api_key_env: None,
        max_tokens: 64,
        temperature: 0.0,
        supports_tools: false,
        supports_thinking: false,
    })
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
            "jishu_pi_models_config_{label}_{}_{}_{}",
            std::process::id(),
            id,
            nanos
        ))
    }

    fn sample_zhipu() -> PiProviderConfig {
        let mut provider = PiProviderConfig::new();
        provider.name = Some("智谱 anthropic 兼容".to_string());
        provider.base_url = Some("https://open.bigmodel.cn/api/anthropic".to_string());
        provider.api_key = Some("sk-zhipu-test".to_string());
        provider.api = Some("anthropic-messages".to_string());
        provider.models = Some(vec![PiModelDefinition {
            id: "glm-5.1".to_string(),
            name: "GLM-5.1".to_string(),
            api: Some("anthropic-messages".to_string()),
            base_url: None,
            reasoning: false,
            thinking_level_map: None,
            input: vec!["text".to_string()],
            cost: PiModelCost {
                input: 0.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
            },
            context_window: 128_000,
            max_tokens: 8_192,
            headers: None,
            compat: None,
        }]);
        provider
    }

    #[test]
    fn load_missing_file_returns_empty_config() {
        let dir = unique_tmp("missing");
        let path = dir.join("models.json");
        let cfg = load_from(&path).unwrap();
        assert!(cfg.providers.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_and_load_roundtrip_zhipu_provider() {
        let dir = unique_tmp("roundtrip");
        let path = dir.join("models.json");
        let mut cfg = PiModelsConfig::default();
        cfg.providers.insert("zhipu".to_string(), sample_zhipu());
        save_to(&path, &cfg).unwrap();

        let loaded = load_from(&path).unwrap();
        let p = loaded.providers.get("zhipu").expect("zhipu provider");
        assert_eq!(
            p.base_url.as_deref(),
            Some("https://open.bigmodel.cn/api/anthropic")
        );
        assert_eq!(p.api.as_deref(), Some("anthropic-messages"));
        assert_eq!(p.api_key.as_deref(), Some("sk-zhipu-test"));
        assert_eq!(p.models.as_ref().unwrap().len(), 1);
        assert_eq!(p.models.as_ref().unwrap()[0].id, "glm-5.1");
        assert_eq!(p.models.as_ref().unwrap()[0].context_window, 128_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn serialized_json_uses_camel_case_keys() {
        let dir = unique_tmp("camel");
        let path = dir.join("models.json");
        let mut cfg = PiModelsConfig::default();
        let mut provider = PiProviderConfig::new();
        provider.base_url = Some("https://example.com".to_string());
        provider.api_key = Some("k".to_string());
        provider.auth_header = Some(true);
        cfg.providers.insert("ex".to_string(), provider);
        save_to(&path, &cfg).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        // Wire format must match Pi's schema exactly.
        assert!(raw.contains("\"baseUrl\""), "raw = {raw}");
        assert!(raw.contains("\"apiKey\""), "raw = {raw}");
        assert!(raw.contains("\"authHeader\""), "raw = {raw}");
        // snake_case must NOT leak into the file.
        assert!(!raw.contains("base_url"), "raw = {raw}");
        assert!(!raw.contains("api_key"), "raw = {raw}");
        assert!(!raw.contains("auth_header"), "raw = {raw}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_optional_fields_are_not_serialized() {
        let mut provider = PiProviderConfig::new();
        provider.base_url = Some("https://example.com".to_string());
        let json = serde_json::to_string(&provider).unwrap();
        // Only the set field should appear; unset ones skipped.
        assert!(json.contains("\"baseUrl\""));
        assert!(!json.contains("\"apiKey\""));
        assert!(!json.contains("\"models\""));
        assert!(!json.contains("\"compat\""));
        assert!(!json.contains("\"headers\""));
        assert!(!json.contains("\"authHeader\""));
        assert!(!json.contains("\"modelOverrides\""));
    }

    #[test]
    fn compat_roundtrips_as_raw_json() {
        let mut provider = PiProviderConfig::new();
        provider.compat = Some(serde_json::json!({
            "supportsDeveloperRole": true,
            "openRouterRouting": { "zdr": true }
        }));
        let json = serde_json::to_string(&provider).unwrap();
        let parsed: PiProviderConfig = serde_json::from_str(&json).unwrap();
        let compat = parsed.compat.unwrap();
        assert_eq!(compat["supportsDeveloperRole"], serde_json::json!(true));
        assert_eq!(compat["openRouterRouting"]["zdr"], serde_json::json!(true));
    }

    #[test]
    fn upsert_and_delete_provider() {
        let dir = unique_tmp("upsert");
        // override default path by writing to a temp file and using the
        // path-bound helpers. For convenience we touch the file directly
        // and use upsert_provider on a real-ish path.
        let home = dirs::home_dir().unwrap();
        let _ = std::fs::create_dir_all(home.join(".jishu-agent").join("agent"));
        // Use a non-default name to avoid clobbering a real file.
        let probe_name = format!("__test_zhipu_{}", std::process::id());
        let probe = sample_zhipu();
        upsert_provider(&probe_name, probe).unwrap();
        let got = get_provider(&probe_name).unwrap();
        assert!(got.is_some(), "provider should exist after upsert");
        let removed = delete_provider(&probe_name).unwrap();
        assert!(removed);
        let after = get_provider(&probe_name).unwrap();
        assert!(after.is_none(), "provider should be gone after delete");
    }

    #[test]
    fn save_to_backs_up_previous_models_json() {
        let dir = unique_tmp("backup");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("models.json");
        std::fs::write(&path, "{\"providers\":{\"old\":{}}}").unwrap();

        save_to(&path, &PiModelsConfig::default()).unwrap();

        let backups_dir = dir.join("backups");
        let entries: Vec<std::path::PathBuf> = std::fs::read_dir(&backups_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        assert_eq!(entries.len(), 1, "one backup per save");
        let name = entries[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(
            name.starts_with("models_") && name.ends_with(".json"),
            "unexpected backup name: {name}"
        );
        assert_eq!(
            std::fs::read_to_string(&entries[0]).unwrap(),
            "{\"providers\":{\"old\":{}}}",
            "backup should hold the pre-save content"
        );
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("providers"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_to_skips_backup_when_file_missing() {
        let dir = unique_tmp("nobackup");
        let path = dir.join("models.json");

        save_to(&path, &PiModelsConfig::default()).unwrap();

        assert!(path.exists());
        let backups_dir = dir.join("backups");
        let backups = if backups_dir.exists() {
            std::fs::read_dir(&backups_dir).unwrap().count()
        } else {
            0
        };
        assert_eq!(backups, 0, "first-time save must not create a backup");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn sample_model_for_preset(id: &str) -> PiModelDefinition {
        PiModelDefinition {
            id: id.to_string(),
            name: format!("Model {id}"),
            api: None,
            base_url: None,
            reasoning: false,
            thinking_level_map: None,
            input: vec!["text".to_string()],
            cost: PiModelCost {
                input: 0.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
            },
            context_window: 128000,
            max_tokens: 8192,
            headers: None,
            compat: None,
        }
    }

    #[test]
    fn test_preset_resolves_provider_fields_with_model_overrides() {
        let mut provider = PiProviderConfig::new();
        provider.base_url = Some("https://provider.example".to_string());
        provider.api = Some("anthropic-messages".to_string());
        provider.api_key = Some("sk-test".to_string());
        let mut model = sample_model_for_preset("glm-5.3");
        model.base_url = Some("https://model-level.example".to_string());
        model.api = Some("openai-completions".to_string());

        let preset = to_test_preset("zhipu", &provider, &model).unwrap();
        // 模型级 api/baseUrl 覆盖渠道级；协议映射到内部 llm 协议。
        assert_eq!(preset.protocol, "openai");
        assert_eq!(preset.base_url, "https://model-level.example");
        assert_eq!(preset.model, "glm-5.3");
        assert_eq!(preset.id, "zhipu/glm-5.3");
        assert_eq!(preset.api_key.as_deref(), Some("sk-test"));
    }

    #[test]
    fn test_preset_defaults_to_anthropic_messages_protocol() {
        let mut provider = PiProviderConfig::new();
        provider.base_url = Some("https://provider.example".to_string());
        let preset = to_test_preset("p", &provider, &sample_model_for_preset("m")).unwrap();
        assert_eq!(preset.protocol, "anthropic");
        assert_eq!(preset.base_url, "https://provider.example");
        assert!(preset.api_key.is_none());
    }

    #[test]
    fn test_preset_errors_without_any_base_url() {
        let provider = PiProviderConfig::new();
        let err = to_test_preset("p", &provider, &sample_model_for_preset("m")).unwrap_err();
        assert!(err.contains("no base URL"), "unexpected error: {err}");
    }

    #[test]
    fn cleanup_keeps_most_recent_models_backups_only() {
        let dir = unique_tmp("cleanup");
        let backups = dir.join("backups");
        std::fs::create_dir_all(&backups).unwrap();
        for i in 0..12 {
            std::fs::write(backups.join(format!("models_20260101_{i:06}.json")), "{}").unwrap();
        }
        std::fs::write(backups.join("settings_20260101_000000.json"), "{}").unwrap();

        super::cleanup_old_models_backups(&backups, 10);

        let models_count = std::fs::read_dir(&backups)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("models_"))
            .count();
        assert_eq!(models_count, 10, "models_ backups capped at 10");
        // settings_ 前缀不受 models 清理影响；保留时间戳最大的 10 份。
        assert!(backups.join("settings_20260101_000000.json").exists());
        assert!(!backups.join("models_20260101_000001.json").exists());
        assert!(backups.join("models_20260101_000011.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
