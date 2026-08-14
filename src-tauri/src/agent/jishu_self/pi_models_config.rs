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
    let home = dirs::home_dir().ok_or_else(|| "Cannot find home directory".to_string())?;
    Ok(home.join(".jishu-agent").join("agent").join("models.json"))
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
    // 2-space indent matches Pi's own JSON style and keeps diffs
    // against Pi-authored models.json readable.
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Cannot serialize models.json: {e}"))?;
    fs::write(path, format!("{json}\n"))
        .map_err(|e| format!("Cannot write models.json to {}: {e}", path.display()))?;
    Ok(())
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
}
