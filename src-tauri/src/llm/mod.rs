pub mod anthropic;
pub mod config;
pub mod http;
pub mod message;
pub mod openai;
pub mod sse;

use message::LlmRequest;

#[derive(Clone)]
pub struct CancelToken(pub std::sync::Arc<std::sync::atomic::AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self(std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)))
    }
    pub fn is_canceled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Relaxed)
    }
    pub fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[derive(Debug)]
pub struct LlmTurn {
    pub stop_reason: message::StopReason,
    pub tool_calls: Vec<message::LlmToolCall>,
    pub usage: Option<crate::agent::normalized::UsageStats>,
}

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("request failed: {0}")]
    Request(String),
    #[error("parse error: {0}")]
    Parse(String),
    #[error("API key error: {0}")]
    ApiKey(String),
    #[error("canceled")]
    Canceled,
}

pub trait LlmProvider: Send + Sync {
    fn stream_chat(
        &self,
        req: LlmRequest,
        emitter: Box<dyn FnMut(crate::agent::NormalizedEvent) + Send>,
        cancel: &CancelToken,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<LlmTurn, LlmError>> + Send + '_>,
    >;
}

pub fn create_provider(preset: &config::ModelPreset) -> Result<Box<dyn LlmProvider>, String> {
    match preset.protocol.as_str() {
        "openai" => Ok(Box::new(openai::OpenAiProvider::new(preset))),
        "anthropic" => Ok(Box::new(anthropic::AnthropicProvider::new(preset))),
        _ => Err(format!("Unknown protocol: {}", preset.protocol)),
    }
}
