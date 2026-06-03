use crate::llm::config::ModelPreset;
use crate::llm::LlmError;
use reqwest::Client;
use std::sync::OnceLock;
use std::time::Duration;

static CLIENT: OnceLock<Client> = OnceLock::new();

pub fn shared_client() -> &'static Client {
    CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("Failed to build HTTP client")
    })
}

/// Resolve API key: stored field first, then env var fallback.
pub fn resolve_api_key(preset: &ModelPreset) -> Result<String, LlmError> {
    // 1. Direct key stored in config
    if let Some(key) = &preset.api_key {
        if !key.is_empty() {
            return Ok(key.clone());
        }
    }
    // 2. Environment variable
    if let Some(env_name) = &preset.api_key_env {
        if !env_name.is_empty() {
            if let Ok(val) = std::env::var(env_name) {
                return Ok(val);
            }
        }
    }
    Err(LlmError::ApiKey(format!(
        "No API key configured for '{}'. Set it in the model config or via environment variable.",
        preset.id
    )))
}

/// Mask a key for display: show first 4 and last 4 chars, mask the rest.
pub fn mask_key(key: &str) -> String {
    if key.len() <= 12 {
        return "*".repeat(key.len());
    }
    format!(
        "{}{}{}",
        &key[..4],
        "*".repeat(key.len() - 8),
        &key[key.len() - 4..]
    )
}
