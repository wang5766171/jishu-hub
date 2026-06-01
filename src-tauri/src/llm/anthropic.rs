use crate::agent::NormalizedEvent;
use crate::llm::config::ModelPreset;
use crate::llm::message::{LlmRequest, StopReason};
use crate::llm::{CancelToken, LlmError, LlmProvider, LlmTurn};

pub struct AnthropicProvider {
    preset: ModelPreset,
}

impl AnthropicProvider {
    pub fn new(preset: &ModelPreset) -> Self {
        Self {
            preset: preset.clone(),
        }
    }
}

impl LlmProvider for AnthropicProvider {
    fn stream_chat(
        &self,
        _req: LlmRequest,
        mut _emitter: Box<dyn FnMut(NormalizedEvent) + Send>,
        cancel: &CancelToken,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<LlmTurn, LlmError>> + Send + '_>,
    > {
        let canceled = cancel.is_canceled();
        Box::pin(async move {
            if canceled {
                return Err(LlmError::Canceled);
            }
            // Stub: return empty turn
            Ok(LlmTurn {
                stop_reason: StopReason::EndTurn,
                tool_calls: vec![],
                usage: None,
            })
        })
    }
}
