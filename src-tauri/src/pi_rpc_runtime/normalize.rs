//! pi_rpc_runtime 子模块（v0.9.5 三轮评审 C13 拆分：零逻辑变更纯移动，
//! 来源与拆分说明见主文件头 §12 处置说明）。

use super::*;

// ---------------------------------------------------------------------------
// Pi AgentEvent → NormalizedEvent
// ---------------------------------------------------------------------------

/// Convert Pi's native `AgentEvent` JSON objects to `NormalizedEvent`.
///
/// Pi events (from `@earendil-works/pi-agent-core`):
/// - `agent_start`, `agent_end`
/// - `turn_start`, `turn_end`
/// - `message_start`, `message_update`, `message_end`
/// - `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
/// 从 turn_end 的 message.usage 构造 UsageStats（v0.7.3 需求2：jishu-self 用量与水位）。
/// context_tokens 公式对齐 pi `calculateContextTokens`（totalTokens 优先，否则四项求和）；
/// context_window 来自启动时 get_state 的 model.contextWindow，缺失时仅报 in/out/cost。
pub(crate) fn pi_turn_usage(
    event: &serde_json::Value,
    context_window: Option<u64>,
) -> Option<UsageStats> {
    let usage = event.get("message").and_then(|m| m.get("usage"))?;
    let num = |key: &str| usage.get(key).and_then(|v| v.as_f64()).map(|v| v as u64);
    let input = num("input");
    let output = num("output");
    let cache_read = num("cacheRead");
    let cache_write = num("cacheWrite");
    let total_tokens = num("totalTokens");
    let total_cost = usage
        .get("cost")
        .and_then(|c| c.get("total"))
        .and_then(|v| v.as_f64());
    if input.is_none()
        && output.is_none()
        && total_cost.is_none()
        && total_tokens.is_none()
        && cache_read.is_none()
        && cache_write.is_none()
    {
        return None;
    }
    let context_tokens = total_tokens.filter(|v| *v > 0).or_else(|| {
        Some(
            input.unwrap_or(0)
                + output.unwrap_or(0)
                + cache_read.unwrap_or(0)
                + cache_write.unwrap_or(0),
        )
    });
    let context_remaining = context_window
        .zip(context_tokens)
        .map(|(total, used)| total.saturating_sub(used));
    Some(UsageStats {
        input_tokens: input,
        output_tokens: output,
        total_cost,
        context_remaining,
        context_window_total: context_window,
    })
}

/// v0.8.0 需求10：分段用量 + 内容归因。usage 部分复用 pi_turn_usage（精确）；
/// 归因部分对 turn_end 的 message.content 逐块估算（thinking/text/toolCall），
/// toolResults 估算为工具结果进入后续上下文的规模。
pub(crate) fn pi_segment_usage(
    event: &serde_json::Value,
    context_window: Option<u64>,
) -> Option<crate::usage_store::SegmentUsage> {
    let base = pi_turn_usage(event, context_window)?;
    let mut seg = crate::usage_store::SegmentUsage {
        stop_reason: event
            .get("message")
            .and_then(|m| m.get("stopReason"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        input_tokens: base.input_tokens.unwrap_or(0),
        output_tokens: base.output_tokens.unwrap_or(0),
        cache_read: event
            .get("message")
            .and_then(|m| m.get("usage"))
            .and_then(|u| u.get("cacheRead"))
            .and_then(|v| v.as_f64())
            .map(|v| v as u64)
            .unwrap_or(0),
        cache_write: event
            .get("message")
            .and_then(|m| m.get("usage"))
            .and_then(|u| u.get("cacheWrite"))
            .and_then(|v| v.as_f64())
            .map(|v| v as u64)
            .unwrap_or(0),
        total_tokens: 0,
        total_cost: base.total_cost.unwrap_or(0.0),
        context_remaining: base.context_remaining,
        context_window_total: base.context_window_total,
        ..Default::default()
    };
    seg.total_tokens = event
        .get("message")
        .and_then(|m| m.get("usage"))
        .and_then(|u| u.get("totalTokens"))
        .and_then(|v| v.as_f64())
        .map(|v| v as u64)
        .unwrap_or(0);

    if let Some(blocks) = event
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        for block in blocks {
            let kind = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match kind {
                "thinking" => {
                    seg.est_thinking += est_block_tokens(block.get("thinking"));
                }
                "text" => {
                    seg.est_text += est_block_tokens(block.get("text"));
                }
                "toolCall" => {
                    // pi-mcp-adapter 注册的 MCP 工具在 toolCall 块上无标志
                    // （实测仅 type/id/name/arguments 四字段），按用户裁决统一
                    // 归入工具桶；est_mcp_tool/mcp_calls 列留作前向预留。
                    let _name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let est = est_block_tokens(Some(&serde_json::Value::Null))
                        + est_block_tokens(block.get("arguments"));
                    seg.est_builtin_tool += est;
                    seg.tool_calls += 1;
                }
                _ => {}
            }
        }
    }
    if let Some(results) = event.get("toolResults").and_then(|v| v.as_array()) {
        for r in results {
            seg.est_tool_results += est_block_tokens(Some(r));
        }
    }
    Some(seg)
}

/// 从 pi compaction_end 事件提取压缩记录（CompactionResult 字段）。
pub(crate) fn pi_compaction_record(
    event: &serde_json::Value,
) -> crate::usage_store::CompactionRecord {
    let num =
        |v: Option<&serde_json::Value>| v.and_then(|x| x.as_f64()).map(|x| x as u64).unwrap_or(0);
    let result = event.get("result");
    let usage = result.and_then(|r| r.get("usage"));
    let cost = usage
        .and_then(|u| u.get("cost"))
        .and_then(|c| c.get("total"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let summary_len = result
        .and_then(|r| r.get("summary"))
        .and_then(|v| v.as_str())
        .map(|s| s.chars().count())
        .unwrap_or(0) as u64;
    crate::usage_store::CompactionRecord {
        reason: event
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        aborted: event
            .get("aborted")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        tokens_before: num(result.and_then(|r| r.get("tokensBefore"))),
        tokens_after: num(result.and_then(|r| r.get("estimatedTokensAfter"))),
        first_kept_entry_id: result
            .and_then(|r| r.get("firstKeptEntryId"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        summary_input: num(usage.and_then(|u| u.get("input"))),
        summary_output: num(usage.and_then(|u| u.get("output"))),
        summary_cost: cost,
        est_summary: ((summary_len as f64) / 2.5).ceil() as u64,
    }
}

/// 估算口径：≈2.5 字符/token（中英混合粗估，构成对比用，非计费值）。
fn est_block_tokens(value: Option<&serde_json::Value>) -> u64 {
    let text = match value {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => return 0,
    };
    ((text.chars().count() as f64) / 2.5).ceil() as u64
}

pub(crate) fn normalize_pi_agent_event(
    event: &serde_json::Value,
    context_window: Option<u64>,
    pending_steers: &mut Vec<String>,
) -> Vec<NormalizedEvent> {
    let event_type = match event.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return vec![],
    };

    match event_type {
        // v0.8.0 需求10：上下文压缩生命周期——开始→状态指示；结束→状态清除
        // + phase_divider(compaction) 分隔线（进内容流，turn_complete 时随
        // content 一并提交，重载时由 pi_session 的 compaction 条目重建）。
        // v0.9.1 需求14：pi 主轮自动重试（agent-session _prepareRetry，RPC
        // 原样透传）——start（attempt/maxAttempts/delayMs/errorMessage）与
        // end（success/attempt/finalError）归一为状态事件；GUI 会话区显性
        // 展示「第 N/M 次重试中（原因）」直至最终失败原因。
        "auto_retry_start" | "auto_retry_end" => {
            let active = event_type == "auto_retry_start";
            vec![NormalizedEvent::AutoRetryStatus {
                active,
                attempt: event.get("attempt").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                max_attempts: event
                    .get("maxAttempts")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
                delay_ms: event.get("delayMs").and_then(|v| v.as_u64()).unwrap_or(0),
                error_message: event
                    .get("errorMessage")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                success: event
                    .get("success")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                final_error: event
                    .get("finalError")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
            }]
        }
        "compaction_start" | "compaction_end" => {
            let active = event_type == "compaction_start";
            let reason = event
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if active {
                vec![
                    NormalizedEvent::PhaseDivider {
                        phase: "compaction".to_string(),
                        title: "上下文压缩中…".to_string(),
                    },
                    NormalizedEvent::CompactionStatus {
                        active: true,
                        reason,
                    },
                ]
            } else {
                // v0.9.1 需求3 #2：compaction_end 自带 aborted/errorMessage 字段
                // （失败路径 agent-session.ts catch 分支），三态呈现——此前一律
                // 「已压缩」把失败静默吞掉。
                let aborted = event
                    .get("aborted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let error_message = event
                    .get("errorMessage")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let title = if error_message.is_some() {
                    "上下文压缩失败".to_string()
                } else if aborted {
                    "上下文压缩已取消".to_string()
                } else {
                    "上下文已压缩".to_string()
                };
                let mut events = vec![
                    NormalizedEvent::CompactionStatus {
                        active: false,
                        reason,
                    },
                    NormalizedEvent::PhaseDivider {
                        phase: "compaction".to_string(),
                        title,
                    },
                ];
                if let Some(error) = error_message {
                    // recoverable：压缩失败不中断会话，用户可重试（手动压缩/下一
                    // 轮阈值触发自动重试）。
                    events.push(NormalizedEvent::Error {
                        message: error,
                        recoverable: true,
                    });
                }
                events
            }
        }

        // -- Streaming text/thinking from assistant message ---------------
        "message_update" => {
            let ame = match event.get("assistantMessageEvent") {
                Some(v) => v,
                None => return vec![],
            };
            let sub_type = ame.get("type").and_then(|v| v.as_str()).unwrap_or_default();
            match sub_type {
                "text_delta" => {
                    let delta = ame
                        .get("delta")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    if delta.is_empty() {
                        vec![]
                    } else {
                        vec![NormalizedEvent::TextDelta {
                            delta: delta.to_string(),
                        }]
                    }
                }
                "thinking_delta" => {
                    let delta = ame
                        .get("delta")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    if delta.is_empty() {
                        vec![]
                    } else {
                        vec![NormalizedEvent::Thinking {
                            delta: delta.to_string(),
                        }]
                    }
                }
                _ => vec![],
            }
        }

        // -- Tool execution lifecycle -------------------------------------
        "tool_execution_start" => {
            // v0.9.4 需求12 测试期诊断（用户实测：长命令执行期间前端无工具卡
            // ——需区分「pi 未发 start」与「hub→前端链路丢」）。dev 终端可见。
            log::info!(
                "[tool-visibility] tool_execution_start call_id={} tool={}",
                event
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?"),
                event
                    .get("toolName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?"),
            );
            let call_id = event
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let tool = event
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let input = event
                .get("args")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            if call_id.is_empty() {
                vec![]
            } else {
                let interactions = interaction_requests_from_tool_call(&call_id, &tool, &input);
                if interactions.is_empty() {
                    let view = crate::agent::tool_view::classify_tool_view_for(
                        "jishu-self",
                        &tool,
                        &input,
                    );
                    vec![NormalizedEvent::ToolUseStart {
                        call_id,
                        tool,
                        input,
                        view: Some(view),
                    }]
                } else {
                    // Pi follows this tool start with an extension_ui_request
                    // carrying the real response id. Emitting an interaction
                    // here creates a duplicate, non-answerable question.
                    vec![]
                }
            }
        }
        "tool_execution_update" => {
            // v0.9.4 需求8：工具执行中间进度（bash 类长时工具的流式输出
            // 快照）。pi 的 partialResult 是 AgentToolResult 形状——文本在
            // content[].text（tools/bash.ts emitOutputUpdate），兜底直出
            // output 字符串字段；均无则不发（不猜形状）。高频事件，前端
            // event-pipeline 侧 per call_id 节流。
            let call_id = event
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let partial = event.get("partialResult");
            let text: Option<String> = partial.and_then(|p| {
                if let Some(arr) = p.get("content").and_then(|v| v.as_array()) {
                    let mut s = String::new();
                    for item in arr {
                        if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                            s.push_str(t);
                        }
                    }
                    if !s.is_empty() {
                        Some(s)
                    } else {
                        None
                    }
                } else {
                    p.get("output")
                        .and_then(|v| v.as_str())
                        .map(|t| t.to_string())
                }
            });
            if call_id.is_empty() || text.is_none() {
                vec![]
            } else {
                vec![NormalizedEvent::ToolUseProgress {
                    call_id,
                    partial_output: text.unwrap(),
                }]
            }
        }
        "tool_execution_end" => {
            let call_id = event
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let is_error = event
                .get("isError")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let result = event
                .get("result")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            // v0.9.4 需求8 测试期修复：pi 的 result 同为 AgentToolResult 形态
            //（文本在 content[].text，与 update 的 partialResult 同源）——原样
            // 透传导致前端结果区显示原始 JSON（用户截图实证）。提取文本后以
            // 字符串透传；非该形状（如 MCP 工具自带结构）保持原样不猜。
            let output = match result {
                serde_json::Value::Null => serde_json::Value::Null,
                ref v @ serde_json::Value::Object(_) => {
                    let text = v.get("content").and_then(|c| c.as_array()).map(|arr| {
                        let mut s = String::new();
                        for item in arr {
                            if let Some(t) = item.get("text").and_then(|x| x.as_str()) {
                                s.push_str(t);
                            }
                        }
                        s
                    });
                    match text {
                        Some(t) if !t.is_empty() => serde_json::Value::String(t),
                        _ => v.clone(),
                    }
                }
                other => other,
            };
            if call_id.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::ToolUseResult {
                    call_id,
                    output,
                    is_error,
                }]
            }
        }

        // -- Turn lifecycle -----------------------------------------------
        "turn_end" => {
            let stop_reason = event
                .get("message")
                .and_then(|m| m.get("stopReason"))
                .and_then(|v| v.as_str())
                .unwrap_or("end_turn");
            // When stopReason is "toolUse", the turn ended because the LLM
            // requested a tool call.  Pi will execute the tool and continue
            // the conversation (generating more text_delta events).  We must
            // NOT emit TurnComplete here — otherwise the frontend drops the
            // streaming state and discards all subsequent events.
            if stop_reason == "toolUse" {
                return vec![];
            }
            let reason = match stop_reason {
                "aborted" => TurnEndReason::Aborted,
                "max_tokens" => TurnEndReason::MaxTokens,
                "error" => TurnEndReason::Error,
                _ => TurnEndReason::Complete,
            };
            vec![NormalizedEvent::TurnComplete {
                reason,
                usage: pi_turn_usage(event, context_window),
            }]
        }

        // -- Session header (emitted in --mode json print mode) -----------
        "session" => {
            if let Some(sid) = event.get("id").and_then(|v| v.as_str()) {
                vec![NormalizedEvent::SessionResolved {
                    session_id: sid.to_string(),
                }]
            } else {
                vec![]
            }
        }

        // -- Steer injection marker --------------------------------------
        // Pi emits `message_start`/`message_end` with `role=user` for a
        // queued steer at the moment it is delivered (typically at a tool-call
        // gap, mid-turn). Surface the steer text so the frontend can split the
        // accumulated assistant content at the injection point and interleave
        // the steer between the two assistant segments — matching the order Pi
        // persists to the session JSONL. The companion `message_end` carries
        // the same payload; one marker per steer is enough, so only
        // `message_start` is converted. Assistant `message_start`
        // (role=assistant) is still ignored: the assistant content arrives
        // incrementally via `message_update` above.
        "message_start" => {
            // Detect PhaseDivider before checking the message role. Extension
            // sendMessage markers use role=custom, while normal steer markers
            // use role=user.
            let custom_type = event
                .get("message")
                .and_then(|m| m.get("customType"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if custom_type.starts_with("jishu-conductor:phase-enter:") {
                let phase = custom_type
                    .strip_prefix("jishu-conductor:phase-enter:")
                    .unwrap_or("");
                // C4-slice2：声明驱动流水线阶段名——消息内容首行 `=== 阶段名 ===`
                // 标记优先（与 session.rs 回放投影同一解析），回落内置映射。
                let content_text = event
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let marker_title = content_text.lines().take(3).find_map(|line| {
                    let trimmed = line.trim();
                    trimmed
                        .strip_prefix("=== ")
                        .and_then(|rest| rest.strip_suffix(" ==="))
                        .filter(|name| !name.is_empty())
                        .map(str::to_string)
                });
                let title = marker_title.unwrap_or_else(|| {
                    match phase {
                        "discuss" => "需求讨论",
                        "plan" => "流程规划",
                        "execute" => "流程执行",
                        "done" => "已完成",
                        other => other,
                    }
                    .to_string()
                });
                return vec![NormalizedEvent::PhaseDivider {
                    phase: phase.to_string(),
                    title,
                }];
            }

            let role = event
                .get("message")
                .and_then(|m| m.get("role"))
                .and_then(|v| v.as_str());
            if role != Some("user") {
                return vec![];
            }

            let content = event
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|v| v.as_array())
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|block| {
                            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                                block
                                    .get("text")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string)
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            if content.is_empty() {
                return vec![];
            }
            // v0.8.0 需求10 修复：pi 对**每条**送达的用户消息都回显
            // message_start(role=user)——含正常 prompt 与压缩前排队的消息；
            // 只有经 Steer 命令注入的文本才是真正的引导（连接循环登记，
            // 此处按文匹配消费），否则会把用户消息误标为「已引导」并重复渲染。
            match pending_steers.iter().position(|s| s == &content) {
                Some(idx) => {
                    pending_steers.remove(idx);
                    vec![NormalizedEvent::SteerInjected { content }]
                }
                None => vec![],
            }
        }

        // 需求1 A7：thinking 级别变更（Pi clamp 后的生效值）。
        "thinking_level_changed" => {
            let level = event
                .get("level")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if level.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::ThinkingLevelChanged { level }]
            }
        }

        // All other event types (agent_start, agent_end, turn_start,
        // message_end) are ignored (tool_execution_update is mapped to
        // ToolUseProgress — see the branch above).
        _ => vec![],
    }
}
