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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractionOption {
    pub option_id: String,
    pub label: String,
    pub description: Option<String>,
}

/// Which transport surfaced a structured interaction. Drives delivery routing
/// (see `agent::interaction::delivery_hint_for`). Defaults to `Unspecified` so
/// legacy/persisted events (without the field) deserialize safely.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum InteractionTransport {
    #[default]
    Unspecified,
    PiRpc,
    AcpPreferred,
    CodexAppServer,
    Cli,
    Embedded,
}

impl InteractionTransport {
    pub fn from_surface(surface: super::TransportSurface) -> Self {
        match surface {
            super::TransportSurface::PiRpc => Self::PiRpc,
            super::TransportSurface::AcpPreferred => Self::AcpPreferred,
            super::TransportSurface::CodexAppServer => Self::CodexAppServer,
            super::TransportSurface::Cli => Self::Cli,
            super::TransportSurface::Embedded => Self::Embedded,
        }
    }
}

/// The protocol channel that produced an interaction. Determines whether the
/// answer can be written back as a true mid-turn pause-resume or must fall back
/// to a follow-up message. See `交互模式通用化设计_20260616.md` §7.1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum InteractionOrigin {
    /// Generic text tool call / unverified channel — safe default, follow-up.
    #[default]
    Text,
    /// Pi `extension_ui_request` (production mid-turn baseline).
    ExtensionUi,
    /// ACP unstable `elicitation/create` (claude_code, capability-gated).
    AcpElicitation,
    /// codex EXPERIMENTAL `item/tool/requestUserInput` business question.
    CodexToolRequestUserInput,
    /// codex `item/tool/requestUserInput` carrying an MCP/connector side-effect
    /// approval (Accept/Decline/Cancel) — routes to the approval path.
    CodexMcpApproval,
    /// codex `item/*/requestApproval` (command/file/permission).
    CodexApproval,
}

/// Expected write-back semantics for an interaction. The frontend uses this as a
/// *hint* only; the authoritative decision is the `InteractionDelivery` returned
/// by `respond_chat_interaction` (design R6 — never assume mid-turn from the
/// event alone).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum InteractionDeliveryHint {
    #[default]
    FollowUp,
    MidTurn,
}

/// Native correlation scope carried with an interaction so the backend can
/// locate the exact pending server request to write back (design R3 — must
/// include `request_kind` to avoid approval/user-input registry collisions).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractionCorrelation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_request_id: Option<String>,
    /// Raw JSON-RPC id (may be number or string) of the originating request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jsonrpc_id: Option<serde_json::Value>,
    /// Disambiguates business/approval/elicitation pending entries sharing scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_kind: Option<String>,
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
        /// v0.8.0 需求2 Phase 1：渲染意图（分类 + 位置），归一化层产出；
        /// UI 只做「意图→组件」映射。旧事件反序列化得 None，兼容。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        view: Option<crate::agent::tool_view::ToolView>,
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
    InteractionRequest {
        request_id: String,
        prompt: String,
        options: Vec<InteractionOption>,
        allow_multiple: bool,
        allow_custom_text: bool,
        required: bool,
        /// Transport that surfaced this interaction. Drives answer routing.
        #[serde(default)]
        transport: InteractionTransport,
        /// Protocol channel / origin. Disambiguates business question vs.
        /// approval vs. elicitation (design R8: same `tool/requestUserInput`
        /// channel carries two semantics — split by payload).
        #[serde(default)]
        origin: InteractionOrigin,
        /// Expected write-back semantics — *hint only*. The authoritative
        /// decision is the `InteractionDelivery` returned by
        /// `respond_chat_interaction` (design R6).
        #[serde(default)]
        delivery_hint: InteractionDeliveryHint,
        /// Native correlation scope for locating the pending server request to
        /// write back (design R3 — includes `request_kind` to prevent registry
        /// collisions between approval and business pending entries).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        correlation: Option<InteractionCorrelation>,
    },
    SessionResolved {
        session_id: String,
    },
    /// Thinking level changed (v0.7.4 需求1 A7). `level` is the *effective*
    /// value after the agent clamps the request to what the current model
    /// supports (pi semantics), so the UI should display this, not the
    /// requested value.
    ThinkingLevelChanged {
        level: String,
    },
    /// A steering user message was injected mid-turn. Pi emits a
    /// `message_start`/`message_end` pair with `role=user` for the queued
    /// steer at a tool-call gap. Carries the steer text so the frontend can
    /// split the accumulated assistant content at the injection point and
    /// interleave the steer between the two assistant segments — matching the
    /// order Pi persists to the session JSONL.
    SteerInjected {
        content: String,
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
    /// Phase divider — emitted when a Pi extension signals a phase transition
    /// (via ctx.ui.setStatus with key "jishu-conductor-phase"). Rendered as a
    /// centered divider line in the chat content area.
    PhaseDivider {
        phase: String,
        title: String,
    },
    /// v0.8.0 需求10：上下文压缩状态（pi compaction_start / compaction_end）。
    /// active=true 进行中（GUI 在会话区显示「压缩中」指示）；false 结束——
    /// 归一化层随同下发 phase_divider(compaction) 在内容流中呈现分隔线。
    CompactionStatus {
        active: bool,
        reason: String,
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
            NormalizedEvent::InteractionRequest { .. } => "interaction_request",
            NormalizedEvent::SessionResolved { .. } => "session_resolved",
            NormalizedEvent::ThinkingLevelChanged { .. } => "thinking_level_changed",
            NormalizedEvent::SteerInjected { .. } => "steer_injected",
            NormalizedEvent::TurnComplete { .. } => "turn_complete",
            NormalizedEvent::Error { .. } => "error",
            NormalizedEvent::TaskStep { .. } => "task_step",
            NormalizedEvent::SubAgentDispatch { .. } => "sub_agent_dispatch",
            NormalizedEvent::Raw { .. } => "raw",
            NormalizedEvent::PhaseDivider { .. } => "phase_divider",
            NormalizedEvent::CompactionStatus { .. } => "compaction_status",
        }
    }
}

/// Returns `true` when the tool's UI rendering is entirely handled by a
/// separate elicitation/interaction channel (e.g. ACP `elicitation/create`),
/// so `normalize_acp_update` must NOT create a `ToolUseStart` card for it.
///
/// Claude Code's `AskUserQuestion` is the canonical example: the ACP bridge
/// sends a `tool_call` session update (which would create a "running" tool
/// card) AND a separate `elicitation/create` RPC request (which creates the
/// actual question UI). The tool card stays in "running" state because the
/// `tool_use_result` only arrives after the user answers — producing a
/// phantom "Tool" card with no useful content.
pub fn is_elicitation_only_tool(tool_name: &str) -> bool {
    // v0.8.0 需求2 Phase 1（02 §1.6 偏离修正）：保留原 3 名**传输特定**语义
    // 不委托 tool_view 的 8 名并集——这 3 个工具在 ACP 传输上由
    // elicitation/create 通道完整渲染 UI，tool_call 镜像事件必须整体抑制，
    // 否则双通道重复渲染（回归测试 ask_user_question_tool_call_is_suppressed
    // 锁定）。渲染语义的权威名单在 tool_view::is_interaction_tool。
    let normalized_name = tool_name
        .rsplit(['/', ':'])
        .next()
        .unwrap_or(tool_name)
        .replace('-', "_")
        .to_ascii_lowercase();
    matches!(
        normalized_name.as_str(),
        "askuserquestion" | "ask_user_question" | "ask_question"
    )
}

pub fn interaction_requests_from_tool_call(
    call_id: &str,
    tool_name: &str,
    input: &serde_json::Value,
) -> Vec<NormalizedEvent> {
    let normalized_name = tool_name
        .rsplit(['/', ':'])
        .next()
        .unwrap_or(tool_name)
        .replace('-', "_")
        .to_ascii_lowercase();
    if !matches!(
        normalized_name.as_str(),
        "request_user_input"
            | "ask_user"
            | "ask_user_input"
            | "ask_question"
            | "askuserquestion"
            | "ask_user_question"
    ) {
        return Vec::new();
    }

    let questions = input
        .get("questions")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![input.clone()]);

    questions
        .iter()
        .enumerate()
        .filter_map(|(index, question)| {
            let prompt = question
                .get("question")
                .or_else(|| question.get("prompt"))
                .or_else(|| question.get("header"))
                .and_then(serde_json::Value::as_str)?
                .trim()
                .to_string();
            if prompt.is_empty() {
                return None;
            }
            let question_id = question
                .get("id")
                .or_else(|| question.get("question_id"))
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| (index + 1).to_string());
            let options = question
                .get("options")
                .and_then(serde_json::Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .enumerate()
                        .filter_map(|(option_index, option)| {
                            if let Some(label) = option.as_str() {
                                return Some(InteractionOption {
                                    option_id: label.to_string(),
                                    label: label.to_string(),
                                    description: None,
                                });
                            }
                            let label = option
                                .get("label")
                                .or_else(|| option.get("title"))
                                .and_then(serde_json::Value::as_str)?
                                .trim()
                                .to_string();
                            if label.is_empty() {
                                return None;
                            }
                            let option_id = option
                                .get("id")
                                .or_else(|| option.get("option_id"))
                                .or_else(|| option.get("value"))
                                .and_then(serde_json::Value::as_str)
                                .filter(|value| !value.trim().is_empty())
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("option_{}", option_index + 1));
                            Some(InteractionOption {
                                option_id,
                                label,
                                description: option
                                    .get("description")
                                    .and_then(serde_json::Value::as_str)
                                    .map(str::to_string),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let allow_multiple = question
                .get("allow_multiple")
                .or_else(|| question.get("multiple"))
                .or_else(|| question.get("is_multi_select"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let allow_custom_text = question
                .get("allow_custom_text")
                .or_else(|| question.get("allow_custom"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(options.is_empty());
            let required = question
                .get("required")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);

            Some(NormalizedEvent::InteractionRequest {
                request_id: format!("{call_id}:{question_id}"),
                prompt,
                options,
                allow_multiple,
                allow_custom_text,
                required,
                // Generic tool-call path: not a verified mid-turn channel, so
                // it defaults to follow-up. Verified mid-turn paths (Pi
                // `extension_ui`, codex `requestUserInput`, ACP elicit) build
                // events directly with full metadata.
                transport: InteractionTransport::default(),
                origin: InteractionOrigin::default(),
                delivery_hint: InteractionDeliveryHint::default(),
                correlation: None,
            })
        })
        .collect()
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
        /// v0.8.0 需求2 Phase 1：随块持久化的渲染意图（直播与回放同源）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        view: Option<crate::agent::tool_view::ToolView>,
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
    /// A persisted interaction (question + answer pair) from an Agent's
    /// structured interaction channel (PiRpc extension_ui, ACP elicitation,
    /// codex requestUserInput, etc.). Embeds both the prompt/options and the
    /// user's answer so the full Q&A context survives session reloads.
    Interaction {
        /// The question text presented to the user.
        prompt: String,
        /// Available options (empty = free-text input only).
        #[serde(default)]
        options: Vec<InteractionOption>,
        /// The user's answer text.
        answer: String,
        /// Selected option IDs (multi-select scenarios).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        selected_options: Vec<String>,
        /// Origin label for display (e.g. "extension_ui", "acp_elicitation").
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<String>,
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

impl ApprovalKind {
    /// 按工具名映射审批类型（复用 tool_view 渲染分类，单一分类源）：
    /// shell → 命令执行；文件写/改/删 → 文件写入；其余（读/搜/思考/MCP）→ 其他。
    /// 审批弹窗据此显示正确类型，不再恒为 Other。
    pub fn for_tool(tool: &str) -> Self {
        match crate::agent::tool_view::classify_name(tool) {
            crate::agent::tool_view::ToolViewKind::ShellExec => ApprovalKind::Command,
            crate::agent::tool_view::ToolViewKind::FileWrite
            | crate::agent::tool_view::ToolViewKind::FileEdit
            | crate::agent::tool_view::ToolViewKind::FileDelete => ApprovalKind::FileWrite,
            _ => ApprovalKind::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageStats {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_cost: Option<f64>,
    pub context_remaining: Option<u64>,
    /// 上下文总窗口（v0.7.3 需求2：水位百分比的分母；ACP usage_update 的 size /
    /// PiRpc 由 get_state 的 model.contextWindow 提供）。
    pub context_window_total: Option<u64>,
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
    fn approval_kind_for_tool_classifies_shell_and_file_writes() {
        // Pi 内置工具名（bash/write/edit/read/grep/find/ls）+ 通用方言名。
        assert_eq!(ApprovalKind::for_tool("bash"), ApprovalKind::Command);
        assert_eq!(ApprovalKind::for_tool("execute_command"), ApprovalKind::Command);
        assert_eq!(ApprovalKind::for_tool("write"), ApprovalKind::FileWrite);
        assert_eq!(ApprovalKind::for_tool("edit"), ApprovalKind::FileWrite);
        assert_eq!(ApprovalKind::for_tool("apply_patch"), ApprovalKind::FileWrite);
        // 读/搜/思考与未知（MCP 等）→ Other。
        assert_eq!(ApprovalKind::for_tool("read"), ApprovalKind::Other);
        assert_eq!(ApprovalKind::for_tool("grep"), ApprovalKind::Other);
        assert_eq!(ApprovalKind::for_tool("mcp__x__y"), ApprovalKind::Other);
    }

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

    #[test]
    fn interaction_request_roundtrip() {
        let event = NormalizedEvent::InteractionRequest {
            request_id: "request-1".into(),
            prompt: "Choose a delivery path".into(),
            options: vec![
                InteractionOption {
                    option_id: "frontend".into(),
                    label: "Frontend first".into(),
                    description: None,
                },
                InteractionOption {
                    option_id: "backend".into(),
                    label: "Backend first".into(),
                    description: Some("Build the API contract first".into()),
                },
            ],
            allow_multiple: false,
            allow_custom_text: true,
            required: true,
            transport: InteractionTransport::PiRpc,
            origin: InteractionOrigin::ExtensionUi,
            delivery_hint: InteractionDeliveryHint::MidTurn,
            correlation: None,
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"kind\":\"interaction_request\""));
        let decoded: NormalizedEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, event);
        assert_eq!(event.event_type(), "interaction_request");
    }

    #[test]
    fn interaction_request_legacy_payload_round_trip_keeps_defaults() {
        // Persisted events from before v0.6.0 interaction-generalization do not
        // carry transport/origin/delivery_hint/correlation. They must still
        // deserialize (defaulting) so the persisted history remains readable.
        let legacy = serde_json::json!({
            "kind": "interaction_request",
            "request_id": "legacy-1",
            "prompt": "旧数据里的提问",
            "options": [],
            "allow_multiple": false,
            "allow_custom_text": false,
            "required": true,
        });
        let decoded: NormalizedEvent = serde_json::from_value(legacy).unwrap();
        match decoded {
            NormalizedEvent::InteractionRequest {
                transport,
                origin,
                delivery_hint,
                correlation,
                ..
            } => {
                assert_eq!(transport, InteractionTransport::Unspecified);
                assert_eq!(origin, InteractionOrigin::Text);
                assert_eq!(delivery_hint, InteractionDeliveryHint::FollowUp);
                assert_eq!(correlation, None);
            }
            other => panic!("expected InteractionRequest, got {other:?}"),
        }
    }

    #[test]
    fn recognizes_structured_request_user_input_tool_calls() {
        let events = interaction_requests_from_tool_call(
            "call-1",
            "request_user_input",
            &serde_json::json!({
                "questions": [{
                    "id": "architecture",
                    "question": "请选择架构",
                    "options": [
                        { "label": "A", "description": "单体" },
                        { "label": "B", "description": "前后端分离" }
                    ]
                }]
            }),
        );

        assert_eq!(
            events,
            vec![NormalizedEvent::InteractionRequest {
                request_id: "call-1:architecture".into(),
                prompt: "请选择架构".into(),
                options: vec![
                    InteractionOption {
                        option_id: "option_1".into(),
                        label: "A".into(),
                        description: Some("单体".into()),
                    },
                    InteractionOption {
                        option_id: "option_2".into(),
                        label: "B".into(),
                        description: Some("前后端分离".into()),
                    },
                ],
                allow_multiple: false,
                allow_custom_text: false,
                required: true,
                transport: InteractionTransport::default(),
                origin: InteractionOrigin::default(),
                delivery_hint: InteractionDeliveryHint::default(),
                correlation: None,
            }]
        );
    }

    #[test]
    fn ignores_ordinary_tool_calls() {
        assert!(interaction_requests_from_tool_call(
            "call-1",
            "read_file",
            &serde_json::json!({ "path": "README.md" }),
        )
        .is_empty());
    }

    #[test]
    fn interaction_content_block_roundtrip() {
        let block = ContentBlock::Interaction {
            prompt: "请选择架构方案".into(),
            options: vec![
                InteractionOption {
                    option_id: "a".into(),
                    label: "单体".into(),
                    description: None,
                },
                InteractionOption {
                    option_id: "b".into(),
                    label: "微服务".into(),
                    description: Some("推荐".into()),
                },
            ],
            answer: "微服务".into(),
            selected_options: vec!["b".into()],
            origin: Some("acp_elicitation".into()),
        };

        let json = serde_json::to_string(&block).unwrap();
        assert!(json.contains("interaction"));
        assert!(json.contains("请选择架构方案"));
        let decoded: ContentBlock = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, block);
    }

    #[test]
    fn interaction_content_block_minimal_fields() {
        // Minimal interaction block (no options, no selected_options, no origin)
        let json = serde_json::json!({
            "interaction": {
                "prompt": "请确认",
                "answer": "是"
            }
        });
        let decoded: ContentBlock = serde_json::from_value(json).unwrap();
        match decoded {
            ContentBlock::Interaction {
                prompt,
                answer,
                options,
                selected_options,
                origin,
            } => {
                assert_eq!(prompt, "请确认");
                assert_eq!(answer, "是");
                assert!(options.is_empty());
                assert!(selected_options.is_empty());
                assert!(origin.is_none());
            }
            other => panic!("Expected Interaction, got {:?}", other),
        }
    }
}
