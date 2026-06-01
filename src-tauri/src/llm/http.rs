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

pub fn resolve_api_key(preset: &ModelPreset) -> Result<String, LlmError> {
    std::env::var(&preset.api_key_env).map_err(|_| {
        LlmError::ApiKey(format!(
            "Environment variable '{}' not set",
            preset.api_key_env
        ))
    })
}
