use std::collections::HashMap;

use crate::agent::normalized::{TurnEndReason, UsageStats};
use crate::agent::NormalizedEvent;
use crate::llm::config::ModelPreset;
use crate::llm::http;
use crate::llm::message::{LlmMessage, LlmRequest, LlmRole, LlmToolCall, StopReason};
use crate::llm::sse::{parse_sse_line, SseLineBuffer};
use crate::llm::{CancelToken, LlmError, LlmProvider, LlmTurn};

use futures_util::StreamExt;

pub struct OpenAiProvider {
    preset: ModelPreset,
}

impl OpenAiProvider {
    pub fn new(preset: &ModelPreset) -> Self {
        Self {
            preset: preset.clone(),
        }
    }
}

/// Map an OpenAI finish_reason string to our StopReason.
fn map_stop_reason(reason: &str) -> StopReason {
    match reason {
        "stop" => StopReason::EndTurn,
        "tool_calls" => StopReason::ToolUse,
        "length" => StopReason::MaxTokens,
        "content_filter" => StopReason::Refusal,
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

/// Build the JSON message array for the OpenAI chat completions endpoint.
fn build_messages(messages: &[LlmMessage]) -> serde_json::Value {
    let out: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            let role = match m.role {
                LlmRole::System => "system",
                LlmRole::User => "user",
                LlmRole::Assistant => "assistant",
                LlmRole::Tool => "tool",
            };

            let mut obj = serde_json::json!({
                "role": role,
            });

            if let Some(content) = &m.content {
                obj["content"] = serde_json::Value::String(content.clone());
            } else {
                obj["content"] = serde_json::Value::Null;
            }

            // Tool calls in assistant messages
            if let Some(tool_calls) = &m.tool_calls {
                let tc_arr: Vec<serde_json::Value> = tool_calls
                    .iter()
                    .map(|tc| {
                        serde_json::json!({
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": tc.arguments.to_string(),
                            }
                        })
                    })
                    .collect();
                obj["tool_calls"] = serde_json::Value::Array(tc_arr);
            }

            // Tool role needs tool_call_id
            if let Some(tool_call_id) = &m.tool_call_id {
                obj["tool_call_id"] = serde_json::Value::String(tool_call_id.clone());
            }

            obj
        })
        .collect();

    serde_json::Value::Array(out)
}

/// Build the tools array in OpenAI function-calling format.
fn build_tools(tools: &[crate::llm::message::LlmTool]) -> serde_json::Value {
    let out: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema,
                }
            })
        })
        .collect();
    serde_json::Value::Array(out)
}

/// Parse SSE data lines and emit NormalizedEvents. Returns (LlmTurn, Vec<NormalizedEvent>).
/// Used by both the live streaming path and tests.
fn process_sse_chunks(
    sse_lines: &[String],
    emitter: &mut dyn FnMut(NormalizedEvent),
) -> Result<LlmTurn, LlmError> {
    // Accumulate tool calls: index -> (id, name, arguments_buffer)
    let mut tool_calls: HashMap<u32, (String, String, String)> = HashMap::new();
    let mut stop_reason = StopReason::EndTurn;
    let mut usage: Option<UsageStats> = None;

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

        // Check for error object
        if let Some(err) = chunk.get("error") {
            let msg = err
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown API error");
            return Err(LlmError::Request(msg.to_string()));
        }

        // Extract choices[0] if present
        let choice = chunk.get("choices").and_then(|c| c.get(0));

        if let Some(choice) = choice {
            // Check finish_reason
            if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
                if !fr.is_empty() {
                    stop_reason = map_stop_reason(fr);
                }
            }

            // Process delta
            if let Some(delta) = choice.get("delta") {
                // Text content
                if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                    if !content.is_empty() {
                        emitter(NormalizedEvent::TextDelta {
                            delta: content.to_string(),
                        });
                    }
                }

                // Tool calls - array with index
                if let Some(tcs) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                    for tc in tcs {
                        let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

                        let entry = tool_calls
                            .entry(idx)
                            .or_insert_with(|| (String::new(), String::new(), String::new()));

                        // First chunk carries id and function.name
                        if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                            entry.0 = id.to_string();
                        }
                        if let Some(name) = tc
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(|v| v.as_str())
                        {
                            entry.1 = name.to_string();
                        }
                        // Subsequent chunks carry partial arguments
                        if let Some(args) = tc
                            .get("function")
                            .and_then(|f| f.get("arguments"))
                            .and_then(|v| v.as_str())
                        {
                            entry.2.push_str(args);
                        }
                    }
                }
            }
        }

        // Extract usage if present (usually in the final chunk with stream_options.include_usage)
        if let Some(u) = chunk.get("usage") {
            usage = Some(UsageStats {
                input_tokens: u.get("prompt_tokens").and_then(|v| v.as_u64()),
                output_tokens: u.get("completion_tokens").and_then(|v| v.as_u64()),
                total_cost: None,
                context_remaining: None,
            });
        }
    }

    // Emit ToolUseStart events for accumulated tool calls
    let mut final_tool_calls: Vec<LlmToolCall> = Vec::new();
    let mut indices: Vec<u32> = tool_calls.keys().copied().collect();
    indices.sort();

    for idx in &indices {
        let (id, name, args_str) = tool_calls.get(idx).unwrap();
        let args: serde_json::Value = if args_str.is_empty() {
            serde_json::Value::Object(serde_json::Map::new())
        } else {
            match serde_json::from_str(args_str) {
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

        emitter(NormalizedEvent::ToolUseStart {
            call_id: id.clone(),
            tool: name.clone(),
            input: args.clone(),
        });

        final_tool_calls.push(LlmToolCall {
            id: id.clone(),
            name: name.clone(),
            arguments: args,
        });
    }

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

impl LlmProvider for OpenAiProvider {
    fn stream_chat(
        &self,
        req: LlmRequest,
        mut emitter: Box<dyn FnMut(NormalizedEvent) + Send>,
        cancel: &CancelToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<LlmTurn, LlmError>> + Send + '_>>
    {
        let preset = self.preset.clone();
        let cancel = cancel.clone();
        Box::pin(async move {
            // Check cancellation upfront
            if cancel.is_canceled() {
                return Err(LlmError::Canceled);
            }

            // Resolve API key
            let api_key = http::resolve_api_key(&preset)?;

            // Build request body
            let mut body = serde_json::json!({
                "model": if req.model.is_empty() { &preset.model } else { &req.model },
                "messages": build_messages(&req.messages),
                "stream": true,
                "stream_options": { "include_usage": true },
            });

            if !req.tools.is_empty() {
                body["tools"] = build_tools(&req.tools);
            }

            if let Some(max_tokens) = req.max_tokens {
                body["max_tokens"] = serde_json::json!(max_tokens);
            } else {
                body["max_tokens"] = serde_json::json!(preset.max_tokens);
            }

            if let Some(temperature) = req.temperature {
                body["temperature"] = serde_json::json!(temperature);
            } else {
                body["temperature"] = serde_json::json!(preset.temperature);
            }

            // Build URL
            let base_url = preset.base_url.trim_end_matches('/');
            let url = format!("{}/chat/completions", base_url);

            // Send request
            let client = http::shared_client();
            let body_str = serde_json::to_string(&body)
                .map_err(|e| LlmError::Parse(format!("Failed to serialize request body: {e}")))?;

            let response = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
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

            // Process SSE stream
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

            // Process collected SSE lines
            let result = process_sse_chunks(&collected_lines, &mut emitter)?;
            Ok(result)
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
            r#"data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
            "data: [DONE]",
        ];

        let (events, result) = collect_events(sse_lines);

        assert!(result.is_ok());
        let turn = result.unwrap();
        assert_eq!(turn.stop_reason, StopReason::EndTurn);
        assert!(turn.tool_calls.is_empty());

        // Should have: TextDelta("Hello"), TextDelta(" world"), TurnComplete
        assert_eq!(events.len(), 3);
        assert!(matches!(&events[0], NormalizedEvent::TextDelta { delta } if delta == "Hello"));
        assert!(matches!(&events[1], NormalizedEvent::TextDelta { delta } if delta == " world"));
        assert!(matches!(
            &events[2],
            NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                ..
            }
        ));
    }

    #[test]
    fn test_tool_call_accumulation() {
        let sse_lines = &[
            r#"data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"ci"}}]},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\":"}}]},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Beijin"}}]},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"g\"}"}}]},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
            "data: [DONE]",
        ];

        let (events, result) = collect_events(sse_lines);

        assert!(result.is_ok());
        let turn = result.unwrap();
        assert_eq!(turn.stop_reason, StopReason::ToolUse);
        assert_eq!(turn.tool_calls.len(), 1);

        let tc = &turn.tool_calls[0];
        assert_eq!(tc.id, "call_abc");
        assert_eq!(tc.name, "get_weather");
        assert_eq!(tc.arguments, serde_json::json!({"city": "Beijing"}));

        // Should have: ToolUseStart, TurnComplete
        assert_eq!(events.len(), 2);
        assert!(
            matches!(&events[0], NormalizedEvent::ToolUseStart { call_id, tool, input }
                if call_id == "call_abc" && tool == "get_weather"
                && input == &serde_json::json!({"city": "Beijing"})
            )
        );
    }

    #[test]
    fn test_finish_reason_mapping() {
        // Test "length" -> MaxTokens
        let sse_lines = &[
            r#"data: {"id":"chatcmpl-3","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"text"},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-3","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}"#,
            "data: [DONE]",
        ];
        let (events, result) = collect_events(sse_lines);
        let turn = result.unwrap();
        assert_eq!(turn.stop_reason, StopReason::MaxTokens);
        assert!(matches!(
            &events.last(),
            Some(NormalizedEvent::TurnComplete {
                reason: TurnEndReason::MaxTokens,
                ..
            })
        ));

        // Test "content_filter" -> Refusal
        let sse_lines = &[
            r#"data: {"id":"chatcmpl-4","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}"#,
            "data: [DONE]",
        ];
        let (_, result) = collect_events(sse_lines);
        let turn = result.unwrap();
        assert_eq!(turn.stop_reason, StopReason::Refusal);
    }

    #[test]
    fn test_usage_stats_extraction() {
        let sse_lines = &[
            r#"data: {"id":"chatcmpl-5","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-5","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":3,"total_tokens":18}}"#,
            "data: [DONE]",
        ];

        let (events, result) = collect_events(sse_lines);
        let turn = result.unwrap();

        assert!(turn.usage.is_some());
        let u = turn.usage.unwrap();
        assert_eq!(u.input_tokens, Some(15));
        assert_eq!(u.output_tokens, Some(3));
        assert_eq!(u.total_cost, None);
        assert_eq!(u.context_remaining, None);

        // TurnComplete event should carry usage too
        let turn_event = &events[events.len() - 1];
        assert!(matches!(
            turn_event,
            NormalizedEvent::TurnComplete { usage: Some(_), .. }
        ));
    }

    #[test]
    fn test_multiple_tool_calls() {
        let sse_lines = &[
            r#"data: {"id":"chatcmpl-6","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}},{"index":1,"id":"call_2","type":"function","function":{"name":"write_file","arguments":""}}]},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-6","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":\"/a\"}"}},{"index":1,"function":{"arguments":"{\"path\":\"/b\""}}]},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-6","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":",\"content\":\"hi\"}"}}]},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-6","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
            "data: [DONE]",
        ];

        let (_, result) = collect_events(sse_lines);
        let turn = result.unwrap();
        assert_eq!(turn.tool_calls.len(), 2);

        assert_eq!(turn.tool_calls[0].id, "call_1");
        assert_eq!(turn.tool_calls[0].name, "read_file");
        assert_eq!(
            turn.tool_calls[0].arguments,
            serde_json::json!({"path": "/a"})
        );

        assert_eq!(turn.tool_calls[1].id, "call_2");
        assert_eq!(turn.tool_calls[1].name, "write_file");
        assert_eq!(
            turn.tool_calls[1].arguments,
            serde_json::json!({"path": "/b", "content": "hi"})
        );
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
                usage: None
            }
        ));
    }

    #[test]
    fn test_api_error_in_stream() {
        let sse_lines = &[
            r#"data: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error","code":"rate_limit_exceeded"}}"#,
        ];
        let (_, result) = collect_events(sse_lines);
        assert!(result.is_err());
        match result.unwrap_err() {
            LlmError::Request(msg) => assert!(msg.contains("Rate limit exceeded")),
            other => panic!("Expected Request error, got: {:?}", other),
        }
    }

    #[test]
    fn test_invalid_json_in_sse() {
        let sse_lines = &["data: {not valid json}"];
        let (_, result) = collect_events(sse_lines);
        assert!(result.is_err());
        match result.unwrap_err() {
            LlmError::Parse(msg) => assert!(msg.contains("Invalid SSE JSON")),
            other => panic!("Expected Parse error, got: {:?}", other),
        }
    }
}
