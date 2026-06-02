use std::collections::HashMap;

use crate::agent::normalized::{TurnEndReason, UsageStats};
use crate::agent::NormalizedEvent;
use crate::llm::config::ModelPreset;
use crate::llm::http;
use crate::llm::message::{LlmMessage, LlmRequest, LlmRole, LlmToolCall, StopReason};
use crate::llm::sse::{parse_sse_line, SseLineBuffer};
use crate::llm::{CancelToken, LlmError, LlmProvider, LlmTurn};

use futures_util::StreamExt;

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

/// Map an Anthropic stop_reason string to our StopReason.
fn map_stop_reason(reason: &str) -> StopReason {
    match reason {
        "end_turn" => StopReason::EndTurn,
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxTokens,
        "stop_sequence" => StopReason::EndTurn,
        _ => StopReason::EndTurn,
    }
}

/// Map a StopReason to a TurnEndReason for the normalized event layer.
fn stop_to_turn_end(reason: &StopReason) -> TurnEndReason {
    match reason {
        StopReason::EndTurn => TurnEndReason::Complete,
        StopReason::ToolUse => TurnEndReason::Complete,
        StopReason::MaxTokens => TurnEndReason::MaxTokens,
        StopReason::Refusal => TurnEndReason::Error,
        StopReason::Canceled => TurnEndReason::Aborted,
    }
}

/// Build the JSON messages array for the Anthropic Messages API.
/// System messages are excluded (they go in the top-level `system` field).
/// Tool-role messages are mapped to `user` with a tool_result content block.
/// Assistant messages with tool_calls are mapped to `assistant` with tool_use content blocks.
fn build_messages(messages: &[LlmMessage]) -> (Option<String>, Vec<serde_json::Value>) {
    let mut system_text: Option<String> = None;
    let mut out: Vec<serde_json::Value> = Vec::new();

    for m in messages {
        match m.role {
            LlmRole::System => {
                // Accumulate system text; last one wins if multiple
                if let Some(content) = &m.content {
                    system_text = Some(content.clone());
                }
            }
            LlmRole::Tool => {
                // Anthropic expects tool results as a user message with tool_result content block
                let tool_call_id = m.tool_call_id.clone().unwrap_or_default();
                let result_content: serde_json::Value = match &m.content {
                    Some(text) => serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": tool_call_id,
                        "content": text,
                    }),
                    None => serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": tool_call_id,
                        "content": "",
                    }),
                };
                out.push(serde_json::json!({
                    "role": "user",
                    "content": [result_content],
                }));
            }
            LlmRole::User => {
                let content = m.content.clone().unwrap_or_default();
                out.push(serde_json::json!({
                    "role": "user",
                    "content": content,
                }));
            }
            LlmRole::Assistant => {
                if let Some(tool_calls) = &m.tool_calls {
                    // Assistant message with tool calls: emit as content blocks
                    let mut blocks: Vec<serde_json::Value> = Vec::new();

                    // Include text content if present
                    if let Some(text) = &m.content {
                        if !text.is_empty() {
                            blocks.push(serde_json::json!({
                                "type": "text",
                                "text": text,
                            }));
                        }
                    }

                    for tc in tool_calls {
                        blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.name,
                            "input": tc.arguments,
                        }));
                    }

                    out.push(serde_json::json!({
                        "role": "assistant",
                        "content": blocks,
                    }));
                } else {
                    let content = m.content.clone().unwrap_or_default();
                    out.push(serde_json::json!({
                        "role": "assistant",
                        "content": content,
                    }));
                }
            }
        }
    }

    (system_text, out)
}

/// Build the tools array in Anthropic format: { name, description, input_schema }
fn build_tools(tools: &[crate::llm::message::LlmTool]) -> serde_json::Value {
    let out: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "description": t.description,
                "input_schema": t.input_schema,
            })
        })
        .collect();
    serde_json::Value::Array(out)
}

/// Process a non-streaming Anthropic Messages API JSON response and emit NormalizedEvents.
/// Format: `{ id, type: "message", role: "assistant", content: [...], model, stop_reason, usage }`
fn process_non_streaming_response(
    resp: &serde_json::Value,
    emitter: &mut dyn FnMut(NormalizedEvent),
) -> Result<LlmTurn, LlmError> {
    // Check for API-level error
    if let Some(error) = resp.get("error") {
        let msg = error
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown API error");
        emitter(NormalizedEvent::Error {
            message: msg.to_string(),
            recoverable: false,
        });
        return Err(LlmError::Request(msg.to_string()));
    }

    let mut stop_reason = StopReason::EndTurn;
    let mut tool_calls: Vec<LlmToolCall> = Vec::new();
    let mut input_tokens: Option<u64> = None;
    let mut output_tokens: Option<u64> = None;

    // Extract stop_reason
    if let Some(reason) = resp.get("stop_reason").and_then(|v| v.as_str()) {
        stop_reason = map_stop_reason(reason);
    }

    // Extract usage
    if let Some(usage) = resp.get("usage") {
        input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64());
        output_tokens = usage.get("output_tokens").and_then(|v| v.as_u64());
    }

    // Process content blocks
    if let Some(content) = resp.get("content").and_then(|v| v.as_array()) {
        for block in content {
            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");

            match block_type {
                "text" => {
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        if !text.is_empty() {
                            emitter(NormalizedEvent::TextDelta {
                                delta: text.to_string(),
                            });
                        }
                    }
                }
                "thinking" => {
                    if let Some(thinking) = block.get("thinking").and_then(|v| v.as_str()) {
                        if !thinking.is_empty() {
                            emitter(NormalizedEvent::Thinking {
                                delta: thinking.to_string(),
                            });
                        }
                    }
                }
                "tool_use" => {
                    let id = block
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let input = block
                        .get("input")
                        .cloned()
                        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

                    emitter(NormalizedEvent::ToolUseStart {
                        call_id: id.clone(),
                        tool: name.clone(),
                        input: input.clone(),
                    });

                    tool_calls.push(LlmToolCall {
                        id,
                        name,
                        arguments: input,
                    });
                }
                _ => {}
            }
        }
    }

    let usage = if input_tokens.is_some() || output_tokens.is_some() {
        Some(UsageStats {
            input_tokens,
            output_tokens,
            total_cost: None,
            context_remaining: None,
        })
    } else {
        None
    };

    let turn_reason = stop_to_turn_end(&stop_reason);
    emitter(NormalizedEvent::TurnComplete {
        reason: turn_reason,
        usage: usage.clone(),
    });

    Ok(LlmTurn {
        stop_reason,
        tool_calls,
        usage,
    })
}

/// Track tool_use block accumulation state by content block index.
struct ToolUseAccumulator {
    /// index -> (id, name, accumulated partial JSON string, is this a tool_use block)
    blocks: HashMap<u32, ToolUseBlock>,
}

struct ToolUseBlock {
    id: String,
    name: String,
    partial_json: String,
    active: bool,
}

impl ToolUseAccumulator {
    fn new() -> Self {
        Self {
            blocks: HashMap::new(),
        }
    }

    /// Record a new tool_use block starting at the given index.
    fn start(&mut self, index: u32, id: String, name: String) {
        self.blocks.insert(
            index,
            ToolUseBlock {
                id,
                name,
                partial_json: String::new(),
                active: true,
            },
        );
    }

    /// Append partial JSON delta to the block at the given index.
    fn append_json(&mut self, index: u32, delta: &str) {
        if let Some(block) = self.blocks.get_mut(&index) {
            block.partial_json.push_str(delta);
        }
    }

    /// Finalize the block at the given index, returning the parsed tool call if it was a tool_use block.
    fn stop(
        &mut self,
        index: u32,
        emitter: &mut dyn FnMut(NormalizedEvent),
    ) -> Option<LlmToolCall> {
        let block = self.blocks.get_mut(&index)?;
        block.active = false;

        let args: serde_json::Value = if block.partial_json.is_empty() {
            serde_json::Value::Object(serde_json::Map::new())
        } else {
            match serde_json::from_str(&block.partial_json) {
                Ok(v) => v,
                Err(e) => {
                    emitter(NormalizedEvent::Error {
                        message: format!("Failed to parse tool call arguments: {e}"),
                        recoverable: true,
                    });
                    serde_json::Value::Object(serde_json::Map::new())
                }
            }
        };

        let tool_call = LlmToolCall {
            id: block.id.clone(),
            name: block.name.clone(),
            arguments: args.clone(),
        };

        emitter(NormalizedEvent::ToolUseStart {
            call_id: block.id.clone(),
            tool: block.name.clone(),
            input: args,
        });

        Some(tool_call)
    }

    /// Collect all finalized tool calls in index order.
    fn collect_sorted(&self) -> Vec<&ToolUseBlock> {
        let mut indices: Vec<u32> = self.blocks.keys().copied().collect();
        indices.sort();
        indices.iter().filter_map(|i| self.blocks.get(i)).collect()
    }
}

/// Parse SSE data lines from the Anthropic Messages API and emit NormalizedEvents.
/// Returns the LlmTurn summarizing the complete response.
fn process_sse_chunks(
    sse_lines: &[String],
    emitter: &mut dyn FnMut(NormalizedEvent),
) -> Result<LlmTurn, LlmError> {
    let mut tool_accum = ToolUseAccumulator::new();
    let mut stop_reason = StopReason::EndTurn;
    let mut input_tokens: Option<u64> = None;
    let mut output_tokens: Option<u64> = None;

    for line in sse_lines {
        let data = match parse_sse_line(line) {
            Some(d) => d,
            None => continue,
        };

        let chunk: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(e) => {
                return Err(LlmError::Parse(format!("Invalid SSE JSON: {e}")));
            }
        };

        let event_type = chunk
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match event_type {
            "message_start" => {
                // Extract input tokens from message.usage
                if let Some(msg) = chunk.get("message") {
                    if let Some(usage) = msg.get("usage") {
                        input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64());
                    }
                }
            }
            "content_block_start" => {
                let index = chunk
                    .get("index")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;

                if let Some(content_block) = chunk.get("content_block") {
                    let block_type = content_block
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    if block_type == "tool_use" {
                        let id = content_block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let name = content_block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        tool_accum.start(index, id, name);
                    }
                    // text and thinking blocks don't need start tracking
                }
            }
            "content_block_delta" => {
                let index = chunk
                    .get("index")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;

                if let Some(delta) = chunk.get("delta") {
                    let delta_type = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");

                    match delta_type {
                        "text_delta" => {
                            if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    emitter(NormalizedEvent::TextDelta {
                                        delta: text.to_string(),
                                    });
                                }
                            }
                        }
                        "thinking_delta" => {
                            if let Some(thinking) =
                                delta.get("thinking").and_then(|v| v.as_str())
                            {
                                if !thinking.is_empty() {
                                    emitter(NormalizedEvent::Thinking {
                                        delta: thinking.to_string(),
                                    });
                                }
                            }
                        }
                        "input_json_delta" => {
                            if let Some(partial) =
                                delta.get("partial_json").and_then(|v| v.as_str())
                            {
                                tool_accum.append_json(index, partial);
                            }
                        }
                        _ => {}
                    }
                }
            }
            "content_block_stop" => {
                let index = chunk
                    .get("index")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;

                // If this index has a tool_use accumulator, finalize it
                if tool_accum.blocks.contains_key(&index) {
                    tool_accum.stop(index, emitter);
                }
            }
            "message_delta" => {
                // Extract stop_reason and output_tokens
                if let Some(delta) = chunk.get("delta") {
                    if let Some(reason) =
                        delta.get("stop_reason").and_then(|v| v.as_str())
                    {
                        stop_reason = map_stop_reason(reason);
                    }
                }
                if let Some(usage) = chunk.get("usage") {
                    output_tokens = usage.get("output_tokens").and_then(|v| v.as_u64());
                }
            }
            "message_stop" => {
                // No additional data needed; the message is complete.
            }
            "ping" => {
                // Keepalive, ignore.
            }
            "error" => {
                let msg = chunk
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown API error");

                emitter(NormalizedEvent::Error {
                    message: msg.to_string(),
                    recoverable: false,
                });

                return Err(LlmError::Request(msg.to_string()));
            }
            _ => {
                // Unknown event type; ignore gracefully.
            }
        }
    }

    // Collect finalized tool calls in index order
    let mut final_tool_calls: Vec<LlmToolCall> = Vec::new();
    let blocks = tool_accum.collect_sorted();
    for block in blocks {
        if !block.active {
            // Already emitted via stop(); reconstruct from block
            let args: serde_json::Value = if block.partial_json.is_empty() {
                serde_json::Value::Object(serde_json::Map::new())
            } else {
                serde_json::from_str(&block.partial_json).unwrap_or(serde_json::Value::Object(
                    serde_json::Map::new(),
                ))
            };
            final_tool_calls.push(LlmToolCall {
                id: block.id.clone(),
                name: block.name.clone(),
                arguments: args,
            });
        }
    }

    // Build usage stats
    let usage = if input_tokens.is_some() || output_tokens.is_some() {
        Some(UsageStats {
            input_tokens,
            output_tokens,
            total_cost: None,
            context_remaining: None,
        })
    } else {
        None
    };

    // Emit TurnComplete
    let turn_reason = stop_to_turn_end(&stop_reason);
    emitter(NormalizedEvent::TurnComplete {
        reason: turn_reason,
        usage: usage.clone(),
    });

    Ok(LlmTurn {
        stop_reason,
        tool_calls: final_tool_calls,
        usage,
    })
}

impl LlmProvider for AnthropicProvider {
    fn stream_chat(
        &self,
        req: LlmRequest,
        mut emitter: Box<dyn FnMut(NormalizedEvent) + Send>,
        cancel: &CancelToken,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<LlmTurn, LlmError>> + Send + '_>,
    > {
        let preset = self.preset.clone();
        let cancel = cancel.clone();
        Box::pin(async move {
            // Check cancellation upfront
            if cancel.is_canceled() {
                return Err(LlmError::Canceled);
            }

            // Resolve API key
            let api_key = http::resolve_api_key(&preset)?;

            // Build messages (extract system text separately)
            let (system_text, messages) = build_messages(&req.messages);

            // Build request body
            let mut body = serde_json::json!({
                "model": if req.model.is_empty() { &preset.model } else { &req.model },
                "messages": messages,
                "stream": true,
                "max_tokens": req.max_tokens.unwrap_or(preset.max_tokens),
            });

            // Add system message as top-level field if present
            if let Some(sys) = system_text {
                body["system"] = serde_json::Value::String(sys);
            }

            // Add temperature if specified. Round to 2 decimal places and convert to f64
            // to avoid f32 precision artifacts (e.g. 0.7 becomes 0.699999988...) that
            // some providers reject.
            let temp = req.temperature.unwrap_or(preset.temperature);
            if temp > 0.0 {
                let rounded = ((temp as f64) * 100.0).round() / 100.0;
                body["temperature"] = serde_json::json!(rounded);
            }

            // Add tools if present
            if !req.tools.is_empty() {
                body["tools"] = build_tools(&req.tools);
            }

            // Build URL — auto-detect path depth so users can paste any prefix:
            //   https://api.anthropic.com         → /v1/messages
            //   https://open.bigmodel.cn/api/anthropic → /v1/messages
            //   https://example.com/v1            → /messages
            //   https://example.com/v1/messages   → use as-is
            //   https://example.com/messages      → use as-is
            let base_url = preset.base_url.trim_end_matches('/');
            let url = if base_url.ends_with("/messages") {
                base_url.to_string()
            } else if base_url.ends_with("/v1") {
                format!("{}/messages", base_url)
            } else {
                format!("{}/v1/messages", base_url)
            };

            // Send request
            let client = http::shared_client();
            let body_str = serde_json::to_string(&body)
                .map_err(|e| LlmError::Parse(format!("Failed to serialize request body: {e}")))?;

            let response = client
                .post(&url)
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .header("Content-Type", "application/json")
                .body(body_str)
                .send()
                .await
                .map_err(|e| LlmError::Request(format!("HTTP request failed: {e}")))?;

            // Check status
            let status = response.status();
            if !status.is_success() {
                let status_text = status.canonical_reason().unwrap_or("Unknown");
                let body_text = response.text().await.unwrap_or_else(|_| String::new());
                return Err(LlmError::Request(format!(
                    "API error {}: {} - {}",
                    status.as_u16(),
                    status_text,
                    body_text.trim()
                )));
            }

            // Detect response type from content-type header.
            // Some Anthropic-compatible providers (e.g. 智谱/ZhiPu) return plain JSON
            // instead of SSE when they don't support streaming.
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");

            if content_type.contains("text/event-stream") {
                // Standard SSE streaming path
                let mut sse_buffer = SseLineBuffer::new();
                let mut stream = response.bytes_stream();
                let mut collected_lines: Vec<String> = Vec::new();

                while let Some(chunk_result) = stream.next().await {
                    if cancel.is_canceled() {
                        emitter(NormalizedEvent::TurnComplete {
                            reason: TurnEndReason::Aborted,
                            usage: None,
                        });
                        return Err(LlmError::Canceled);
                    }

                    let chunk = chunk_result
                        .map_err(|e| LlmError::Request(format!("Stream read error: {e}")))?;

                    let lines = sse_buffer.feed(&chunk);
                    collected_lines.extend(lines);
                }

                let result = process_sse_chunks(&collected_lines, &mut emitter)?;
                Ok(result)
            } else {
                // Non-streaming JSON response — read full body and parse as a
                // standard Anthropic Messages API response.
                let body_bytes = response
                    .bytes()
                    .await
                    .map_err(|e| LlmError::Request(format!("Failed to read response body: {e}")))?;

                let resp: serde_json::Value = serde_json::from_slice(&body_bytes)
                    .map_err(|e| LlmError::Parse(format!("Failed to parse JSON response: {e}")))?;

                process_non_streaming_response(&resp, &mut emitter)
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: process a slice of raw SSE-line strings, collect emitted events.
    fn collect_events(sse_lines: &[&str]) -> (Vec<NormalizedEvent>, Result<LlmTurn, LlmError>) {
        let lines: Vec<String> = sse_lines.iter().map(|s| s.to_string()).collect();
        let mut events: Vec<NormalizedEvent> = Vec::new();
        let result = process_sse_chunks(&lines, &mut |ev| {
            events.push(ev);
        });
        (events, result)
    }

    #[test]
    fn test_text_delta_parsing() {
        let sse_lines = &[
            r#"data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10}}}"#,
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}"#,
            r#"data: {"type":"content_block_stop","index":0}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#,
            r#"data: {"type":"message_stop"}"#,
        ];

        let (events, result) = collect_events(sse_lines);

        assert!(result.is_ok());
        let turn = result.unwrap();
        assert_eq!(turn.stop_reason, StopReason::EndTurn);
        assert!(turn.tool_calls.is_empty());
        assert!(turn.usage.is_some());
        let u = turn.usage.unwrap();
        assert_eq!(u.input_tokens, Some(10));
        assert_eq!(u.output_tokens, Some(5));

        // Should have: TextDelta("Hello"), TextDelta(" world"), TurnComplete
        assert_eq!(events.len(), 3);
        assert!(matches!(
            &events[0],
            NormalizedEvent::TextDelta { delta } if delta == "Hello"
        ));
        assert!(matches!(
            &events[1],
            NormalizedEvent::TextDelta { delta } if delta == " world"
        ));
        assert!(matches!(
            &events[2],
            NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                usage: Some(_),
            }
        ));
    }

    #[test]
    fn test_thinking_delta_parsing() {
        let sse_lines = &[
            r#"data: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":20}}}"#,
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" about this"}}"#,
            r#"data: {"type":"content_block_stop","index":0}"#,
            r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Here is my answer"}}"#,
            r#"data: {"type":"content_block_stop","index":1}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":30}}"#,
            r#"data: {"type":"message_stop"}"#,
        ];

        let (events, result) = collect_events(sse_lines);

        assert!(result.is_ok());
        let turn = result.unwrap();
        assert_eq!(turn.stop_reason, StopReason::EndTurn);

        // Should have: Thinking("Let me think"), Thinking(" about this"), TextDelta("Here is my answer"), TurnComplete
        assert_eq!(events.len(), 4);
        assert!(matches!(
            &events[0],
            NormalizedEvent::Thinking { delta } if delta == "Let me think"
        ));
        assert!(matches!(
            &events[1],
            NormalizedEvent::Thinking { delta } if delta == " about this"
        ));
        assert!(matches!(
            &events[2],
            NormalizedEvent::TextDelta { delta } if delta == "Here is my answer"
        ));
        assert!(matches!(
            &events[3],
            NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                ..
            }
        ));
    }

    #[test]
    fn test_tool_call_accumulation() {
        let sse_lines = &[
            r#"data: {"type":"message_start","message":{"id":"msg_3","usage":{"input_tokens":15}}}"#,
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_abc","name":"get_weather"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"ci"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ty\":"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"Beijin"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"g\"}"}}"#,
            r#"data: {"type":"content_block_stop","index":0}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":10}}"#,
            r#"data: {"type":"message_stop"}"#,
        ];

        let (events, result) = collect_events(sse_lines);

        assert!(result.is_ok());
        let turn = result.unwrap();
        assert_eq!(turn.stop_reason, StopReason::ToolUse);
        assert_eq!(turn.tool_calls.len(), 1);

        let tc = &turn.tool_calls[0];
        assert_eq!(tc.id, "toolu_abc");
        assert_eq!(tc.name, "get_weather");
        assert_eq!(tc.arguments, serde_json::json!({"city": "Beijing"}));

        // Should have: ToolUseStart, TurnComplete
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            NormalizedEvent::ToolUseStart { call_id, tool, input }
            if call_id == "toolu_abc" && tool == "get_weather"
            && input == &serde_json::json!({"city": "Beijing"})
        ));
    }

    #[test]
    fn test_stop_reason_mapping() {
        // Test "max_tokens" -> MaxTokens
        let sse_lines = &[
            r#"data: {"type":"message_start","message":{"id":"msg_4","usage":{"input_tokens":5}}}"#,
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"cut off"}}"#,
            r#"data: {"type":"content_block_stop","index":0}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":2}}"#,
            r#"data: {"type":"message_stop"}"#,
        ];
        let (events, result) = collect_events(sse_lines);
        let turn = result.unwrap();
        assert_eq!(turn.stop_reason, StopReason::MaxTokens);
        assert!(matches!(
            events.last(),
            Some(NormalizedEvent::TurnComplete {
                reason: TurnEndReason::MaxTokens,
                ..
            })
        ));

        // Test "stop_sequence" -> EndTurn
        let sse_lines = &[
            r#"data: {"type":"message_start","message":{"id":"msg_5","usage":{"input_tokens":5}}}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"stop_sequence"},"usage":{"output_tokens":0}}"#,
            r#"data: {"type":"message_stop"}"#,
        ];
        let (_, result) = collect_events(sse_lines);
        let turn = result.unwrap();
        assert_eq!(turn.stop_reason, StopReason::EndTurn);
    }

    #[test]
    fn test_error_event() {
        let sse_lines = &[
            r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        ];

        let (events, result) = collect_events(sse_lines);

        // Should have emitted an Error event
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            NormalizedEvent::Error {
                message,
                recoverable: false,
            } if message == "Overloaded"
        ));

        // Should return an error
        assert!(result.is_err());
        match result.unwrap_err() {
            LlmError::Request(msg) => assert!(msg.contains("Overloaded")),
            other => panic!("Expected Request error, got: {:?}", other),
        }
    }

    #[test]
    fn test_empty_stream_returns_end_turn() {
        let sse_lines: &[&str] = &[];
        let (events, result) = collect_events(sse_lines);
        let turn = result.unwrap();
        assert_eq!(turn.stop_reason, StopReason::EndTurn);
        assert!(turn.tool_calls.is_empty());
        assert!(turn.usage.is_none());
        // Should still emit TurnComplete
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                usage: None,
            }
        ));
    }

    #[test]
    fn test_ping_event_ignored() {
        let sse_lines = &[
            r#"data: {"type":"message_start","message":{"id":"msg_6","usage":{"input_tokens":5}}}"#,
            r#"data: {"type":"ping"}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}"#,
            r#"data: {"type":"message_stop"}"#,
        ];

        let (events, result) = collect_events(sse_lines);
        assert!(result.is_ok());
        // Only TurnComplete should be emitted (no text/thinking/tool events)
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], NormalizedEvent::TurnComplete { .. }));
    }

    #[test]
    fn test_build_messages_extracts_system() {
        let messages = vec![
            LlmMessage {
                role: LlmRole::System,
                content: Some("You are helpful".into()),
                tool_calls: None,
                tool_call_id: None,
            },
            LlmMessage {
                role: LlmRole::User,
                content: Some("Hello".into()),
                tool_calls: None,
                tool_call_id: None,
            },
        ];

        let (system, msgs) = build_messages(&messages);

        assert_eq!(system, Some("You are helpful".to_string()));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"], "Hello");
    }

    #[test]
    fn test_build_messages_tool_result() {
        let messages = vec![
            LlmMessage {
                role: LlmRole::Assistant,
                content: None,
                tool_calls: Some(vec![LlmToolCall {
                    id: "toolu_1".into(),
                    name: "read".into(),
                    arguments: serde_json::json!({"path": "/a"}),
                }]),
                tool_call_id: None,
            },
            LlmMessage {
                role: LlmRole::Tool,
                content: Some("file contents".into()),
                tool_calls: None,
                tool_call_id: Some("toolu_1".into()),
            },
        ];

        let (system, msgs) = build_messages(&messages);

        assert!(system.is_none());
        assert_eq!(msgs.len(), 2);

        // First message: assistant with tool_use content block
        assert_eq!(msgs[0]["role"], "assistant");
        let content = msgs[0]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "tool_use");

        // Second message: user with tool_result content block
        assert_eq!(msgs[1]["role"], "user");
        let content = msgs[1]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "tool_result");
        assert_eq!(content[0]["tool_use_id"], "toolu_1");
        assert_eq!(content[0]["content"], "file contents");
    }

    #[test]
    fn test_non_streaming_text_response() {
        let resp = serde_json::json!({
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": "Hello world"}],
            "model": "claude-sonnet-4-6",
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 5}
        });

        let mut events: Vec<NormalizedEvent> = Vec::new();
        let result = process_non_streaming_response(&resp, &mut |ev| {
            events.push(ev);
        });

        assert!(result.is_ok());
        let turn = result.unwrap();
        assert_eq!(turn.stop_reason, StopReason::EndTurn);
        assert!(turn.tool_calls.is_empty());
        assert_eq!(turn.usage.as_ref().unwrap().input_tokens, Some(10));
        assert_eq!(turn.usage.as_ref().unwrap().output_tokens, Some(5));

        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            NormalizedEvent::TextDelta { delta } if delta == "Hello world"
        ));
        assert!(matches!(
            &events[1],
            NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                ..
            }
        ));
    }

    #[test]
    fn test_non_streaming_tool_use_response() {
        let resp = serde_json::json!({
            "id": "msg_tool",
            "type": "message",
            "role": "assistant",
            "content": [
                {"type": "text", "text": "Let me check"},
                {"type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": {"city": "Beijing"}}
            ],
            "model": "test",
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 8, "output_tokens": 12}
        });

        let mut events: Vec<NormalizedEvent> = Vec::new();
        let result = process_non_streaming_response(&resp, &mut |ev| {
            events.push(ev);
        });

        assert!(result.is_ok());
        let turn = result.unwrap();
        assert_eq!(turn.stop_reason, StopReason::ToolUse);
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "get_weather");

        // Events: TextDelta, ToolUseStart, TurnComplete
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn test_non_streaming_error_response() {
        let resp = serde_json::json!({
            "type": "error",
            "error": {"type": "invalid_request_error", "message": "Bad request"}
        });

        let mut events: Vec<NormalizedEvent> = Vec::new();
        let result = process_non_streaming_response(&resp, &mut |ev| {
            events.push(ev);
        });

        assert!(result.is_err());
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            NormalizedEvent::Error { message, recoverable: false } if message == "Bad request"
        ));
    }
}
