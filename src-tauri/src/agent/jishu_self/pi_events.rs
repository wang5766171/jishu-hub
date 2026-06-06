use crate::agent::normalized::{NormalizedEvent, TurnEndReason};

pub(crate) fn convert_pi_event(value: serde_json::Value) -> Vec<NormalizedEvent> {
    let event_type = value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    match event_type {
        "session" => value
            .get("id")
            .and_then(|v| v.as_str())
            .map(|session_id| {
                vec![NormalizedEvent::SessionResolved {
                    session_id: session_id.to_string(),
                }]
            })
            .unwrap_or_else(|| raw(value)),

        // Stream delta events — only the actual deltas need to surface
        // to the GUI; *_start / *_end carry no per-character data and
        // would only add noise if forwarded.
        "message_update" => convert_message_update(value),

        "tool_execution_start" => vec![NormalizedEvent::ToolUseStart {
            call_id: string_field(&value, "toolCallId"),
            tool: string_field(&value, "toolName"),
            input: value
                .get("args")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        }],
        "tool_execution_end" => vec![NormalizedEvent::ToolUseResult {
            call_id: string_field(&value, "toolCallId"),
            output: value
                .get("result")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            is_error: value
                .get("isError")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        }],

        // message_end can carry an assistant message with
        // stopReason = "error" / "aborted" and an errorMessage. Surface
        // that as a NormalizedEvent::Error so the GUI displays it
        // instead of silently dropping it.
        "message_end" => convert_message_end(value),

        "turn_end" | "agent_end" => vec![NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Complete,
            usage: None,
        }],

        // Lifecycle / bookkeeping events that the GUI doesn't render
        // directly. Skip them so they don't pollute the stream.
        "agent_start"
        | "turn_start"
        | "message_start"
        | "tool_execution_update"
        | "queue_update"
        | "compaction_start"
        | "compaction_end"
        | "session_info_changed"
        | "thinking_level_changed"
        | "auto_retry_start"
        | "auto_retry_end" => Vec::new(),

        _ => raw(value),
    }
}

fn convert_message_update(value: serde_json::Value) -> Vec<NormalizedEvent> {
    let assistant_event = value.get("assistantMessageEvent");
    match assistant_event
        .and_then(|event| event.get("type"))
        .and_then(|v| v.as_str())
    {
        Some("text_delta") => vec![NormalizedEvent::TextDelta {
            delta: assistant_event
                .and_then(|event| event.get("delta"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        }],
        Some("thinking_delta") => vec![NormalizedEvent::Thinking {
            delta: assistant_event
                .and_then(|event| event.get("delta"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        }],
        // text_start / text_end / thinking_start / thinking_end /
        // toolcall_start / toolcall_delta / toolcall_end / done / start /
        // error — these are Pi AssistantMessageEvent lifecycle events
        // that don't carry per-character data. Drop them silently so
        // the GUI stream isn't polluted.
        _ => Vec::new(),
    }
}

fn convert_message_end(value: serde_json::Value) -> Vec<NormalizedEvent> {
    let Some(message) = value.get("message") else {
        return Vec::new();
    };
    let role = message.get("role").and_then(|v| v.as_str()).unwrap_or_default();
    if role != "assistant" {
        return Vec::new();
    }

    let stop_reason = message
        .get("stopReason")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let error_message = message
        .get("errorMessage")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    match (stop_reason, error_message) {
        ("error", Some(msg)) if !msg.is_empty() => vec![NormalizedEvent::Error {
            message: msg,
            recoverable: false,
        }],
        ("aborted", Some(msg)) if !msg.is_empty() => vec![NormalizedEvent::Error {
            message: format!("aborted: {msg}"),
            recoverable: false,
        }],
        ("error", _) => vec![NormalizedEvent::Error {
            message: "assistant message ended with stopReason=error (no errorMessage)".to_string(),
            recoverable: false,
        }],
        _ => Vec::new(),
    }
}

fn string_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

fn raw(value: serde_json::Value) -> Vec<NormalizedEvent> {
    vec![NormalizedEvent::Raw {
        agent: "jishu-pi".to_string(),
        raw: value,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::normalized::TurnEndReason;
    use serde_json::json;

    #[test]
    fn converts_session_header() {
        let events = convert_pi_event(json!({
            "type": "session",
            "version": 3,
            "id": "sid-1",
            "timestamp": "2026-06-01T00:00:00.000Z",
            "cwd": "D:\\Work"
        }));

        assert_eq!(
            events,
            vec![NormalizedEvent::SessionResolved {
                session_id: "sid-1".to_string()
            }]
        );
    }

    #[test]
    fn converts_text_delta() {
        let events = convert_pi_event(json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "text_delta", "delta": "hello" }
        }));

        assert_eq!(
            events,
            vec![NormalizedEvent::TextDelta {
                delta: "hello".to_string()
            }]
        );
    }

    #[test]
    fn converts_thinking_delta() {
        let events = convert_pi_event(json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "thinking_delta", "delta": "plan" }
        }));

        assert_eq!(
            events,
            vec![NormalizedEvent::Thinking {
                delta: "plan".to_string()
            }]
        );
    }

    #[test]
    fn converts_tool_execution_start() {
        let events = convert_pi_event(json!({
            "type": "tool_execution_start",
            "toolCallId": "call-1",
            "toolName": "Read",
            "args": { "file": "Cargo.toml" }
        }));

        assert_eq!(
            events,
            vec![NormalizedEvent::ToolUseStart {
                call_id: "call-1".to_string(),
                tool: "Read".to_string(),
                input: json!({ "file": "Cargo.toml" }),
            }]
        );
    }

    #[test]
    fn converts_tool_execution_end() {
        let events = convert_pi_event(json!({
            "type": "tool_execution_end",
            "toolCallId": "call-1",
            "toolName": "Read",
            "result": { "text": "ok" },
            "isError": false
        }));

        assert_eq!(
            events,
            vec![NormalizedEvent::ToolUseResult {
                call_id: "call-1".to_string(),
                output: json!({ "text": "ok" }),
                is_error: false,
            }]
        );
    }

    #[test]
    fn converts_turn_end_and_agent_end_to_turn_complete() {
        assert_eq!(
            convert_pi_event(json!({"type": "turn_end"})),
            vec![NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                usage: None,
            }]
        );
        assert_eq!(
            convert_pi_event(json!({"type": "agent_end"})),
            vec![NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                usage: None,
            }]
        );
    }

    #[test]
    fn preserves_unknown_event_as_raw() {
        let raw = json!({"type": "new_pi_event", "value": 1});

        assert_eq!(
            convert_pi_event(raw.clone()),
            vec![NormalizedEvent::Raw {
                agent: "jishu-pi".to_string(),
                raw,
            }]
        );
    }

    #[test]
    fn drops_lifecycle_events() {
        for event_type in [
            "agent_start",
            "turn_start",
            "message_start",
            "tool_execution_update",
            "queue_update",
            "compaction_start",
            "compaction_end",
            "session_info_changed",
            "thinking_level_changed",
            "auto_retry_start",
            "auto_retry_end",
        ] {
            let events = convert_pi_event(json!({"type": event_type}));
            assert!(
                events.is_empty(),
                "expected no events for lifecycle type {event_type}, got {events:?}"
            );
        }
    }

    #[test]
    fn message_end_with_error_emits_error_event() {
        let events = convert_pi_event(json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "stopReason": "error",
                "errorMessage": "401 invalid x-api-key",
                "model": "glm-5.1",
                "provider": "anthropic"
            }
        }));

        assert_eq!(
            events,
            vec![NormalizedEvent::Error {
                message: "401 invalid x-api-key".to_string(),
                recoverable: false,
            }]
        );
    }

    #[test]
    fn message_end_with_normal_stop_drops_event() {
        let events = convert_pi_event(json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "stopReason": "stop"
            }
        }));

        assert!(events.is_empty());
    }

    #[test]
    fn message_end_user_message_drops_event() {
        let events = convert_pi_event(json!({
            "type": "message_end",
            "message": {
                "role": "user",
                "content": "hello"
            }
        }));

        assert!(events.is_empty());
    }

    #[test]
    fn message_update_non_delta_drops_event() {
        // AssistantMessageEvent types that are not text_delta / thinking_delta
        // (e.g. text_start, toolcall_*, done, error) should not surface.
        for inner_type in [
            "start",
            "text_start",
            "text_end",
            "thinking_start",
            "thinking_end",
            "toolcall_start",
            "toolcall_delta",
            "toolcall_end",
            "done",
            "error",
        ] {
            let events = convert_pi_event(json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": inner_type }
            }));
            assert!(
                events.is_empty(),
                "expected no events for inner type {inner_type}, got {events:?}"
            );
        }
    }
}
