use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStepKind {
    Plan,
    Dispatch,
    Reflect,
    Verify,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NormalizedEvent {
    TextDelta {
        delta: String,
    },
    Message {
        content: Vec<ContentBlock>,
    },
    ToolUseStart {
        call_id: String,
        tool: String,
        input: serde_json::Value,
    },
    ToolUseResult {
        call_id: String,
        output: serde_json::Value,
        is_error: bool,
    },
    Thinking {
        delta: String,
    },
    ApprovalRequest {
        request_id: String,
        approval_kind: ApprovalKind,
        payload: serde_json::Value,
    },
    SessionResolved {
        session_id: String,
    },
    TurnComplete {
        reason: TurnEndReason,
        usage: Option<UsageStats>,
    },
    Error {
        message: String,
        recoverable: bool,
    },
    TaskStep {
        run_id: String,
        step_id: String,
        #[serde(rename = "step_kind")]
        kind: TaskStepKind,
        title: String,
        detail: Option<serde_json::Value>,
    },
    SubAgentDispatch {
        run_id: String,
        step_id: String,
        target_agent: String,
        sub_run_id: Option<String>,
        request: serde_json::Value,
    },
    Raw {
        agent: String,
        raw: serde_json::Value,
    },
}

impl NormalizedEvent {
    pub fn event_type(&self) -> &'static str {
        match self {
            NormalizedEvent::TextDelta { .. } => "text_delta",
            NormalizedEvent::Message { .. } => "message",
            NormalizedEvent::ToolUseStart { .. } => "tool_use_start",
            NormalizedEvent::ToolUseResult { .. } => "tool_use_result",
            NormalizedEvent::Thinking { .. } => "thinking",
            NormalizedEvent::ApprovalRequest { .. } => "approval_request",
            NormalizedEvent::SessionResolved { .. } => "session_resolved",
            NormalizedEvent::TurnComplete { .. } => "turn_complete",
            NormalizedEvent::Error { .. } => "error",
            NormalizedEvent::TaskStep { .. } => "task_step",
            NormalizedEvent::SubAgentDispatch { .. } => "sub_agent_dispatch",
            NormalizedEvent::Raw { .. } => "raw",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool_use_id: String,
        content: serde_json::Value,
        is_error: bool,
    },
    Thinking {
        thinking: String,
    },
    Image {
        source: ImageSource,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TurnEndReason {
    Complete,
    Aborted,
    Error,
    MaxTokens,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ApprovalKind {
    Command,
    FileWrite,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageStats {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_cost: Option<f64>,
    pub context_remaining: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImageSource {
    pub url: Option<String>,
    pub path: Option<String>,
    pub data_base64: Option<String>,
    pub mime: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NormalizedMessage {
    pub role: String,
    pub content: Vec<ContentBlock>,
    pub timestamp: Option<i64>,
}

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("Agent not found: {0}")]
    NotFound(String),
    #[error("Agent not installed: {0}")]
    NotInstalled(String),
    #[error("Unsupported operation")]
    Unsupported,
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

#[cfg(test)]
mod tests_v6 {
    use super::*;

    #[test]
    fn task_step_roundtrip() {
        let event = NormalizedEvent::TaskStep {
            run_id: "r1".into(),
            step_id: "s1".into(),
            kind: TaskStepKind::Dispatch,
            title: "Dispatch to codex".into(),
            detail: Some(serde_json::json!({ "agent": "codex" })),
        };
        let json = serde_json::to_string(&event).unwrap();
        let de: NormalizedEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(event, de);
    }

    #[test]
    fn sub_agent_dispatch_roundtrip() {
        let event = NormalizedEvent::SubAgentDispatch {
            run_id: "r1".into(),
            step_id: "s1".into(),
            target_agent: "codex".into(),
            sub_run_id: None,
            request: serde_json::json!({ "message": "hello" }),
        };
        let json = serde_json::to_string(&event).unwrap();
        let de: NormalizedEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(event, de);
    }
}
