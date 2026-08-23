use super::*;

fn extract_chunk_text(update: &serde_json::Value) -> &str {
    if let Some(content) = update.get("content") {
        if let Some(s) = content.get("text").and_then(|v| v.as_str()) {
            return s;
        }
        if let Some(s) = content.as_str() {
            return s;
        }
    }
    update
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
}

pub(crate) fn normalize_acp_update(
    params: &serde_json::Value,
    usage_acc: &mut Option<UsageStats>,
) -> Vec<NormalizedEvent> {
    let update = match params.get("update") {
        Some(u) => u,
        None => return vec![],
    };

    // Discriminator: Zed's ACP spec uses `update.type`, but earlier code read
    // `update.sessionUpdate`. Accept BOTH so a server using either shape is
    // parsed (the wrong one previously dropped 100% of opencode content).
    let update_type = update
        .get("type")
        .or_else(|| update.get("sessionUpdate"))
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    match update_type {
        "agent_message_chunk" => {
            let text = extract_chunk_text(update);
            if text.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::TextDelta {
                    delta: text.to_string(),
                }]
            }
        }
        "agent_thought_chunk" => {
            let text = extract_chunk_text(update);
            if text.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::Thinking {
                    delta: text.to_string(),
                }]
            }
        }
        "tool_call" => {
            let call_id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let tool = update
                .get("toolName")
                .or_else(|| update.get("name"))
                .or_else(|| update.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let input = update
                .get("rawInput")
                .or_else(|| update.get("input"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            if call_id.is_empty() {
                vec![]
            } else if is_elicitation_only_tool(&tool) {
                vec![]
            } else {
                let interactions = interaction_requests_from_tool_call(&call_id, &tool, &input);
                if interactions.is_empty() {
                    let view = crate::agent::tool_view::classify_tool_view(&tool, &input);
                    vec![NormalizedEvent::ToolUseStart {
                        call_id,
                        tool,
                        input,
                        view: Some(view),
                    }]
                } else {
                    interactions
                }
            }
        }
        "tool_call_update" => {
            let call_id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or_default();

            if call_id.is_empty() || status != "completed" {
                return vec![];
            }

            // Suppress the result for elicitation-only tools whose start was
            // also suppressed (see the tool_call branch above). Without a
            // matching ToolUseStart the frontend has no card to update, and
            // the orphan tool_use_result would be silently ignored.
            let tool = update
                .get("toolName")
                .or_else(|| update.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if is_elicitation_only_tool(tool) {
                return vec![];
            }

            let output = update
                .get("content")
                .and_then(|c| {
                    if let Some(arr) = c.as_array() {
                        arr.first()
                            .and_then(|item| item.get("content"))
                            .and_then(|inner| inner.get("text"))
                            .cloned()
                    } else {
                        c.get("text").cloned()
                    }
                })
                .unwrap_or(serde_json::Value::Null);

            vec![NormalizedEvent::ToolUseResult {
                call_id,
                output,
                is_error: false,
            }]
        }
        "usage_update" => {
            *usage_acc = Some(UsageStats {
                input_tokens: None,
                output_tokens: None,
                total_cost: update
                    .get("cost")
                    .and_then(|c| c.get("amount"))
                    .and_then(|v| v.as_f64()),
                context_remaining: update
                    .get("size")
                    .and_then(|v| v.as_u64())
                    .zip(update.get("used").and_then(|v| v.as_u64()))
                    .map(|(size, used)| size.saturating_sub(used)),
                // usage_update 自带上下文总量（size），转发给 GUI 做水位百分比
                context_window_total: update.get("size").and_then(|v| v.as_u64()),
            });
            vec![]
        }
        _ => vec![],
    }
}

/// Returns `true` for normalised events that represent visible agent content
/// (text, thinking, tool calls). Used to detect silent empty turns where the
/// ACP server returns `end_turn` without streaming any content.
pub(super) fn is_content_event(event: &NormalizedEvent) -> bool {
    matches!(
        event,
        NormalizedEvent::TextDelta { .. }
            | NormalizedEvent::Thinking { .. }
            | NormalizedEvent::ToolUseStart { .. }
            | NormalizedEvent::Message { .. }
    )
}

pub(super) fn acp_unexpected_eof_error(
    state: &LoopState,
    session_id: &str,
    stderr: &str,
) -> Option<String> {
    if matches!(state, LoopState::Prompting { .. }) {
        let mut message = format!(
            "ACP process exited unexpectedly (session {session_id}). Check stderr for details."
        );
        let stderr = stderr.trim();
        if !stderr.is_empty() {
            message.push_str("\n\nACP stderr:\n");
            message.push_str(stderr);
        }
        Some(message)
    } else {
        None
    }
}

pub(super) fn emit_events(
    app: &tauri::AppHandle,
    agent_id: &str,
    session_id: &str,
    events: &[NormalizedEvent],
) {
    let chunks: Vec<AgentStreamChunk> = events
        .iter()
        .filter_map(|event| {
            let data = serde_json::to_value(event).ok()?;
            Some(AgentStreamChunk {
                agent_id: agent_id.to_string(),
                session_id: session_id.to_string(),
                event_type: event.event_type().to_string(),
                data,
            })
        })
        .collect();
    if !chunks.is_empty() {
        let _ = app.emit("agent-event", &chunks);
    }
}

pub(super) fn flush_buf(emit: &AcpEventEmit, session_id: &str, buf: &mut Vec<NormalizedEvent>) {
    if buf.is_empty() {
        return;
    }
    emit(buf, session_id);
    buf.clear();
}
