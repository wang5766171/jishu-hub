//! Multi-turn LLM tool-calling loop.
//!
//! Used by the orchestrator's "Plan mode" agent. Drives a conversation
//! where the LLM can invoke registered tools (e.g. `load_skill`,
//! `finish_plan`), feeds the tool results back, and continues the
//! stream until the LLM emits a final answer (or the user cancels).
//!
//! This is the "jishu agent" runtime — a single LLM with async
//! function calling, no subprocess spawn.

use crate::agent::normalized::NormalizedEvent;
use crate::llm::message::{LlmMessage, LlmRequest, LlmRole, LlmTool, LlmToolCall};
use crate::llm::{create_provider, CancelToken, LlmProvider, LlmTurn};
use futures_util::future::join_all;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::Mutex;

pub use crate::llm::message::LlmRequest as _LlmRequest;
pub use crate::llm::message::LlmTool as _LlmTool;

/// A tool the LLM can invoke during plan generation. Handler is async
/// (returns a future) so the runtime can host I/O-bound tools (file
/// reads, HTTP calls, MCP requests) alongside in-process logic.
pub type AsyncToolHandler = Arc<
    dyn Fn(
            serde_json::Value,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>>
        + Send
        + Sync,
>;

pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    pub handler: AsyncToolHandler,
}

pub struct AgentLoopConfig {
    pub system_prompt: String,
    pub initial_user_message: String,
    pub tools: Vec<ToolDef>,
    pub max_iterations: usize,
}

impl Default for AgentLoopConfig {
    fn default() -> Self {
        Self {
            system_prompt: String::new(),
            initial_user_message: String::new(),
            tools: Vec::new(),
            max_iterations: 12,
        }
    }
}

/// Stream of events the HUB listens to while a plan is being generated.
pub enum AgentEvent {
    /// LLM is generating prose. HUB shows this in the "thinking" area.
    TextDelta(String),
    /// LLM decided to call a tool. HUB shows "calling X with Y".
    ToolCallStarted {
        name: String,
        arguments: serde_json::Value,
    },
    /// Tool returned a result. HUB shows "X returned: Y".
    ToolCallFinished {
        name: String,
        result: String,
        is_error: bool,
    },
    /// Plan generation completed (LLM emitted finish_plan tool).
    PlanReady(serde_json::Value),
    /// Run finished — either plan was set or user cancelled or error.
    Done,
}

/// Result of an agent run: the final plan JSON (or None if cancelled).
pub struct AgentRunResult {
    pub plan: Option<serde_json::Value>,
    pub iterations: usize,
}

/// Drive the multi-turn tool loop. Emits AgentEvents via the emitter
/// closure. Awaits until the agent finishes (LLM emits finish_plan,
/// max_iterations reached, or cancel is set).
pub async fn run_tool_loop(
    cfg: AgentLoopConfig,
    cancel: CancelToken,
    emit: Box<dyn FnMut(AgentEvent) + Send>,
) -> Result<AgentRunResult, String> {
    // Wrap emit in Arc<Mutex<>> so we can share it with the .await future
    // and reclaim ownership after.
    let emit_arc: Arc<std::sync::Mutex<Box<dyn FnMut(AgentEvent) + Send>>> =
        Arc::new(std::sync::Mutex::new(emit));

    // Build the LLM provider from the active model preset
    let store = crate::llm::config::ModelStore::load()
        .map_err(|e| format!("Cannot load model config: {e}"))?;
    let preset = store
        .get_active()
        .ok_or_else(|| "No active model configured".to_string())?
        .clone();
    let provider =
        create_provider(&preset).map_err(|e| format!("Cannot create LLM provider: {e}"))?;

    // Build LLM tools from the defs
    let llm_tools: Vec<LlmTool> = cfg
        .tools
        .iter()
        .map(|t| LlmTool {
            name: t.name.clone(),
            description: t.description.clone(),
            tool_type: "function".to_string(),
            input_schema: t.input_schema.clone(),
        })
        .collect();

    let tool_map: HashMap<String, AsyncToolHandler> = cfg
        .tools
        .iter()
        .map(|t| (t.name.clone(), t.handler.clone()))
        .collect();

    // Build initial message list
    let messages: Arc<Mutex<Vec<LlmMessage>>> = Arc::new(Mutex::new(vec![
        LlmMessage {
            role: LlmRole::System,
            content: Some(cfg.system_prompt.clone()),
            tool_calls: None,
            tool_call_id: None,
        },
        LlmMessage {
            role: LlmRole::User,
            content: Some(cfg.initial_user_message.clone()),
            tool_calls: None,
            tool_call_id: None,
        },
    ]));

    let mut plan_result: Option<serde_json::Value> = None;
    let mut iterations = 0;

    for _ in 0..cfg.max_iterations {
        if cancel.is_canceled() {
            break;
        }
        iterations += 1;

        // Snapshot messages
        let msgs = {
            let guard = messages.lock().await;
            guard.clone()
        };

        let req = LlmRequest {
            model: preset.model.clone(),
            messages: msgs,
            tools: llm_tools.clone(),
            stream: true,
            max_tokens: Some(preset.max_tokens),
            temperature: Some(preset.temperature),
        };

        // Stream LLM response. Collect text deltas + tool calls.
        let cancel_for_emit = cancel.clone();
        let messages_for_emit = messages.clone();
        let text_buf = Arc::new(Mutex::new(String::new()));
        let tool_calls_buf: Arc<Mutex<Vec<LlmToolCall>>> = Arc::new(Mutex::new(Vec::new()));

        let text_buf_clone = text_buf.clone();
        let tool_calls_buf_clone = tool_calls_buf.clone();
        let emit_arc_for_call = emit_arc.clone();

        let result = {
            let local_emitter = move |event: NormalizedEvent| match &event {
                NormalizedEvent::TextDelta { delta } => {
                    if let Ok(mut t) = text_buf_clone.try_lock() {
                        t.push_str(delta);
                    }
                    if let Ok(mut g) = emit_arc_for_call.lock() {
                        (g)(AgentEvent::TextDelta(delta.clone()));
                    }
                }
                NormalizedEvent::ToolUseStart {
                    call_id,
                    tool,
                    input,
                } => {
                    if let Ok(mut g) = tool_calls_buf_clone.try_lock() {
                        g.push(LlmToolCall {
                            id: call_id.clone(),
                            name: tool.clone(),
                            arguments: input.clone(),
                        });
                    }
                    if let Ok(mut g) = emit_arc_for_call.lock() {
                        (g)(AgentEvent::ToolCallStarted {
                            name: tool.clone(),
                            arguments: input.clone(),
                        });
                    }
                }
                NormalizedEvent::Error { message, .. } => {
                    eprintln!("[llm_agent] LLM error: {message}");
                }
                _ => {}
            };
            provider
                .stream_chat(req, Box::new(local_emitter), &cancel_for_emit)
                .await
        };

        if cancel.is_canceled() {
            break;
        }

        let turn: LlmTurn = match result {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[llm_agent] stream error: {e}");
                break;
            }
        };

        // Append assistant message
        let final_text = text_buf.lock().await.clone();
        let tool_calls: Vec<LlmToolCall> = tool_calls_buf.lock().await.clone();
        {
            let mut guard = messages_for_emit.lock().await;
            guard.push(LlmMessage {
                role: LlmRole::Assistant,
                content: if final_text.is_empty() {
                    None
                } else {
                    Some(final_text)
                },
                tool_calls: if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls.clone())
                },
                tool_call_id: None,
            });
        }

        match turn.stop_reason {
            crate::llm::message::StopReason::EndTurn => {
                // LLM done without tool call — conversation turn complete.
                break;
            }
            crate::llm::message::StopReason::ToolUse => {
                // Execute all tool calls in parallel (each is async).
                let futs = tool_calls.into_iter().map(|call| {
                    let tool_map = &tool_map;
                    let emit_arc = emit_arc.clone();
                    let messages = messages_for_emit.clone();
                    async move {
                        let result = match tool_map.get(&call.name) {
                            Some(handler) => match handler(call.arguments.clone()).await {
                                Ok(s) => {
                                    if let Ok(mut g) = emit_arc.lock() {
                                        (g)(AgentEvent::ToolCallFinished {
                                            name: call.name.clone(),
                                            result: s.clone(),
                                            is_error: false,
                                        });
                                    }
                                    s
                                }
                                Err(e) => {
                                    let err_msg = format!("Error: {e}");
                                    if let Ok(mut g) = emit_arc.lock() {
                                        (g)(AgentEvent::ToolCallFinished {
                                            name: call.name.clone(),
                                            result: err_msg.clone(),
                                            is_error: true,
                                        });
                                    }
                                    err_msg
                                }
                            },
                            None => format!("Error: unknown tool '{}'", call.name),
                        };

                        let is_finish = call.name == "finish_plan";
                        if is_finish {
                            // Signal: plan is ready, skip the LLM echo-back
                            // (we don't want the model to "respond" to its
                            // own finish_plan call).
                            Some((call, result, true))
                        } else {
                            // Feed the tool result back to the LLM
                            let mut guard = messages.lock().await;
                            guard.push(LlmMessage {
                                role: LlmRole::Tool,
                                content: Some(result),
                                tool_calls: None,
                                tool_call_id: Some(call.id.clone()),
                            });
                            Some((call, String::new(), false))
                        }
                    }
                });
                let results = join_all(futs).await;

                // Check for finish_plan signal
                for opt in results.into_iter().flatten() {
                    if opt.2 {
                        // is_finish_plan
                        plan_result = Some(opt.0.arguments.clone());
                        if let Ok(mut g) = emit_arc.lock() {
                            (g)(AgentEvent::PlanReady(opt.0.arguments.clone()));
                        }
                        break;
                    }
                }
                if plan_result.is_some() {
                    break;
                }
            }
            crate::llm::message::StopReason::MaxTokens
            | crate::llm::message::StopReason::Refusal
            | crate::llm::message::StopReason::Canceled => {
                eprintln!("[llm_agent] LLM ended with {:?}", turn.stop_reason);
                break;
            }
        }
    }

    // Emit Done
    let _ = emit_arc.lock().map(|mut g| (g)(AgentEvent::Done));
    Ok(AgentRunResult {
        plan: plan_result,
        iterations,
    })
}
