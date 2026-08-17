use serde::{Deserialize, Serialize};

/// 单次 LLM 请求的载体（连通性测试等链路在用）。
/// v0.6 旧版 ModelStore（models.json 的 presets/active 格式）已随 Pi
/// 模型库切换删除——持久化统一走 agent::jishu_self::pi_models_config。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPreset {
    pub id: String,
    pub display_name: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    /// Stored API key (plaintext). If empty, falls back to api_key_env env var.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Environment variable name to read the API key from as fallback.
    #[serde(default)]
    pub api_key_env: Option<String>,
    pub max_tokens: u32,
    pub temperature: f32,
    pub supports_tools: bool,
    pub supports_thinking: bool,
}

/// Map a pi-style provider `api` value to the internal llm protocol id.
/// Only the two protocols the internal llm client implements are testable.
pub fn protocol_for_pi_api(api: &str) -> Result<&'static str, String> {
    match api {
        "anthropic-messages" => Ok("anthropic"),
        "openai-completions" | "openai-responses" => Ok("openai"),
        other => Err(format!(
            "Connection test does not support protocol '{other}'"
        )),
    }
}
