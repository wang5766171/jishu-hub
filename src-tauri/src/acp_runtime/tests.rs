use super::*;

#[test]
fn normalizes_agent_message_chunk() {
    let params = json!({
        "sessionId": "ses_1",
        "update": {
            "sessionUpdate": "agent_message_chunk",
            "messageId": "msg_1",
            "content": { "type": "text", "text": "Hello" }
        }
    });
    let mut usage = None;
    let events = normalize_acp_update(&params, &mut usage);
    assert_eq!(
        events,
        vec![NormalizedEvent::TextDelta {
            delta: "Hello".to_string()
        }]
    );
}

#[test]
fn normalizes_agent_thought_chunk() {
    let params = json!({
        "sessionId": "ses_1",
        "update": {
            "sessionUpdate": "agent_thought_chunk",
            "messageId": "msg_1",
            "content": { "type": "text", "text": "thinking..." }
        }
    });
    let mut usage = None;
    let events = normalize_acp_update(&params, &mut usage);
    assert_eq!(
        events,
        vec![NormalizedEvent::Thinking {
            delta: "thinking...".to_string()
        }]
    );
}

#[test]
fn normalizes_tool_call() {
    let params = json!({
        "sessionId": "ses_1",
        "update": {
            "sessionUpdate": "tool_call",
            "toolCallId": "call_001",
            "title": "Reading file",
            "kind": "other",
            "status": "pending"
        }
    });
    let mut usage = None;
    let events = normalize_acp_update(&params, &mut usage);
    assert_eq!(
        events,
        vec![NormalizedEvent::ToolUseStart {
            call_id: "call_001".to_string(),
            tool: "Reading file".to_string(),
            input: serde_json::Value::Null,
        }]
    );
}

#[test]
fn normalizes_structured_interaction_tool_call() {
    let params = json!({
        "sessionId": "ses_1",
        "update": {
            "sessionUpdate": "tool_call",
            "toolCallId": "call_002",
            "toolName": "request_user_input",
            "rawInput": {
                "prompt": "请选择权限模型",
                "options": [
                    { "id": "rbac", "label": "RBAC" },
                    { "id": "abac", "label": "ABAC" }
                ]
            },
            "status": "pending"
        }
    });
    let mut usage = None;
    let events = normalize_acp_update(&params, &mut usage);

    assert!(matches!(
        events.as_slice(),
        [NormalizedEvent::InteractionRequest {
            request_id,
            prompt,
            ..
        }] if request_id == "call_002:1" && prompt == "请选择权限模型"
    ));
}

#[test]
fn normalizes_tool_call_update_completed() {
    let params = json!({
        "sessionId": "ses_1",
        "update": {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call_001",
            "status": "completed",
            "content": [{
                "type": "content",
                "content": { "type": "text", "text": "file contents here" }
            }]
        }
    });
    let mut usage = None;
    let events = normalize_acp_update(&params, &mut usage);
    assert_eq!(
        events,
        vec![NormalizedEvent::ToolUseResult {
            call_id: "call_001".to_string(),
            output: json!("file contents here"),
            is_error: false,
        }]
    );
}

#[test]
fn ask_user_question_tool_call_is_suppressed() {
    // Regression: Claude Code's AskUserQuestion creates a phantom "Tool"
    // card stuck in "running" because the tool_use_result only arrives
    // after the elicitation is answered. The tool_call must be suppressed
    // since the UI is rendered by the elicitation/create channel instead.
    let params = json!({
        "sessionId": "ses_1",
        "update": {
            "sessionUpdate": "tool_call",
            "toolCallId": "call_010",
            "toolName": "AskUserQuestion",
            "rawInput": {
                "questions": [{ "question": "Pick one", "options": ["A", "B"] }]
            },
            "status": "pending"
        }
    });
    let mut usage = None;
    let events = normalize_acp_update(&params, &mut usage);
    assert!(
        events.is_empty(),
        "AskUserQuestion tool_call must be suppressed, got {events:?}"
    );
}

#[test]
fn ask_user_question_tool_call_update_is_suppressed() {
    // The completion event for a suppressed elicitation-only tool must
    // also be suppressed to avoid an orphan tool_use_result.
    let params = json!({
        "sessionId": "ses_1",
        "update": {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call_010",
            "toolName": "AskUserQuestion",
            "status": "completed",
            "content": [{ "type": "content", "content": { "type": "text", "text": "A" } }]
        }
    });
    let mut usage = None;
    let events = normalize_acp_update(&params, &mut usage);
    assert!(
        events.is_empty(),
        "AskUserQuestion tool_call_update must be suppressed, got {events:?}"
    );
}

#[test]
fn normalizes_usage_update() {
    let params = json!({
        "sessionId": "ses_1",
        "update": {
            "sessionUpdate": "usage_update",
            "used": 5000,
            "size": 200000,
            "cost": { "amount": 0.01, "currency": "USD" }
        }
    });
    let mut usage = None;
    let events = normalize_acp_update(&params, &mut usage);
    assert!(events.is_empty());
    assert_eq!(usage.as_ref().unwrap().context_remaining, Some(195000));
    assert_eq!(usage.as_ref().unwrap().total_cost, Some(0.01));
}

#[test]
fn ignores_unknown_update_types() {
    let params = json!({
        "sessionId": "ses_1",
        "update": {
            "sessionUpdate": "available_commands_update",
            "availableCommands": []
        }
    });
    let mut usage = None;
    let events = normalize_acp_update(&params, &mut usage);
    assert!(events.is_empty());
}

#[test]
fn selects_permission_options_by_kind_or_id() {
    let params = json!({
        "options": [
            { "optionId": "reject-once", "kind": "reject_once" },
            { "optionId": "allow-once", "kind": "allow_once" }
        ]
    });

    assert_eq!(
        permission_option_id(&params, true).as_deref(),
        Some("allow-once")
    );
    assert_eq!(
        permission_option_id(&params, false).as_deref(),
        Some("reject-once")
    );
}

#[test]
fn never_treats_an_unknown_permission_option_as_approval() {
    let params = json!({
        "options": [
            { "optionId": "custom", "kind": "custom" }
        ]
    });

    assert_eq!(permission_option_id(&params, true), None);
    assert_eq!(permission_option_id(&params, false), None);
}

#[test]
fn initialize_payload_advertises_form_elicitation_as_object_capability() {
    let params = acp_initialize_params();
    assert_eq!(
        params["clientCapabilities"]["elicitation"]["form"],
        json!({})
    );
}

#[test]
fn eof_while_prompting_reports_unexpected_exit() {
    let state = LoopState::Prompting { prompt_id: 42 };
    let message = acp_unexpected_eof_error(&state, "ses-dead", "bridge stacktrace")
        .expect("prompting EOF should be surfaced as an error");

    assert!(message.contains("ACP process exited unexpectedly"));
    assert!(message.contains("ses-dead"));
    assert!(message.contains("bridge stacktrace"));
}

// ---- M1.4 Phase 2: characterize the event-production units that Phase 1
// rerouted through the callback emitter.
// NOTE: the emitter is an `Arc<dyn Fn>` (not an enum-with-a-channel-variant)
// because constructing that enum variant in the test binary triggered a
// Windows load-time entry-point failure; a plain closure capturing a channel
// does not.

#[tokio::test]
async fn callback_emitter_pushes_events_to_channel() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<NormalizedEvent>();
    let emit: AcpEventEmit = Arc::new(move |events: &[NormalizedEvent], _session_id: &str| {
        for event in events {
            let _ = tx.send(event.clone());
        }
    });
    emit(&[NormalizedEvent::TextDelta { delta: "a".into() }], "ses-1");
    drop(emit);
    let mut collected = Vec::new();
    while let Some(event) = rx.recv().await {
        collected.push(event);
    }
    assert_eq!(collected.len(), 1);
    assert!(matches!(
        &collected[0],
        NormalizedEvent::TextDelta { delta } if delta == "a"
    ));
}

#[test]
fn handle_prompt_response_produces_turn_complete_on_success() {
    let mut buf: Vec<NormalizedEvent> = Vec::new();
    let mut usage = None;
    let msg = json!({ "result": { "stopReason": "end_turn", "usage": { "inputTokens": 5, "outputTokens": 7 } } });
    handle_prompt_response(&msg, &mut usage, &mut buf);
    // handle_prompt_response moves usage into the TurnComplete event (via
    // .take()), so the `usage` local is None afterward — check the event.
    assert_eq!(buf.len(), 1);
    match &buf[0] {
        NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Complete,
            usage: Some(used),
        } => {
            assert_eq!(used.input_tokens, Some(5));
            assert_eq!(used.output_tokens, Some(7));
        }
        other => panic!("expected TurnComplete(Complete) with usage, got {other:?}"),
    }
}

#[test]
fn handle_prompt_response_produces_error_then_failed_turn_on_error() {
    let mut buf: Vec<NormalizedEvent> = Vec::new();
    let mut usage: Option<UsageStats> = None;
    let msg = json!({ "error": { "message": "boom" } });
    handle_prompt_response(&msg, &mut usage, &mut buf);
    assert_eq!(buf.len(), 2);
    assert!(matches!(&buf[0], NormalizedEvent::Error { .. }));
    assert!(matches!(
        &buf[1],
        NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Error,
            ..
        }
    ));
}

// ---- Phase 1 (R7 / R3): ACP interaction routing + 分表隔离 ----

#[test]
fn acp_steer_queues_follow_up_while_prompting() {
    let mut queued = std::collections::VecDeque::new();
    let state = LoopState::Prompting { prompt_id: 7 };

    let action = queue_acp_steer_follow_up(&state, &mut queued, "guide me".to_string());

    assert_eq!(action, AcpSteerAction::Queued);
    assert_eq!(queued.pop_front().as_deref(), Some("guide me"));
}

#[test]
fn acp_follow_up_queue_drains_fifo_after_prompt_response() {
    let mut queued =
        std::collections::VecDeque::from(["first guide".to_string(), "second guide".to_string()]);

    assert_eq!(
        pop_next_acp_follow_up(&mut queued).as_deref(),
        Some("first guide")
    );
    assert_eq!(
        pop_next_acp_follow_up(&mut queued).as_deref(),
        Some("second guide")
    );
    assert!(pop_next_acp_follow_up(&mut queued).is_none());
}

#[test]
fn routes_interaction_answer_to_pending_elicitation_as_accept() {
    let mut pending = HashMap::new();
    pending.insert(
        "req-1".to_string(),
        PendingElicitation {
            rpc_id: json!(42),
            questions: vec![AcpQuestion {
                field_name: "f0".to_string(),
                prompt: "prompt".to_string(),
                options: vec![],
                is_multi_select: false,
            }],
            current_index: 0,
            answers: serde_json::Map::new(),
        },
    );

    match route_acp_interaction_response(&mut pending, "req-1_0", "A") {
        AcpInteractionRoute::Elicit {
            rpc_id,
            action,
            content,
        } => {
            assert_eq!(rpc_id, json!(42));
            assert_eq!(action, ElicitAction::Accept);
            assert_eq!(content, json!({ "f0": "A" }));
        }
        _ => panic!("expected Elicit route"),
    }
}

#[test]
fn routes_interaction_answer_to_no_channel_when_no_pending_elicitation() {
    // No pending elicitations at all → opencode-style agent with no mid-turn
    // business channel. The answer must be delivered as a follow-up message.
    let mut pending: HashMap<String, PendingElicitation> = HashMap::new();
    assert!(matches!(
        route_acp_interaction_response(&mut pending, "missing_0", "A"),
        AcpInteractionRoute::NoChannel
    ));
}

#[test]
fn interaction_routing_never_consults_the_permission_table() {
    // R3 分表: a pending request_permission for the SAME request id must NOT
    // be matched by the interaction router. The router only takes the
    // elicitations table (proven by its signature), so even an approval
    // sharing the id resolves to NoChannel rather than consuming the
    // permission. This guards against business/permission cross-consumption.
    let mut pending_elicitations: HashMap<String, PendingElicitation> = HashMap::new();
    let mut pending_permissions: HashMap<String, PendingPermission> = HashMap::new();
    pending_permissions.insert(
        "shared-id".to_string(),
        PendingPermission {
            rpc_id: json!(7),
            allow_option_id: Some("allow".to_string()),
            reject_option_id: Some("reject".to_string()),
        },
    );

    // The interaction router cannot see pending_permissions; the approval
    // remains untouched.
    assert!(matches!(
        route_acp_interaction_response(&mut pending_elicitations, "shared-id_0", "A"),
        AcpInteractionRoute::NoChannel
    ));
    assert!(pending_permissions.contains_key("shared-id"));
}

#[test]
fn elicit_result_payload_shapes_three_state_protocol_response() {
    let content = json!({ "f0": "B" });
    assert_eq!(
        elicit_result_payload(ElicitAction::Accept, content.clone()),
        json!({ "action": "accept", "content": { "f0": "B" } })
    );
    assert_eq!(
        elicit_result_payload(ElicitAction::Decline, content.clone()),
        json!({ "action": "decline" })
    );
    assert_eq!(
        elicit_result_payload(ElicitAction::Cancel, json!(null)),
        json!({ "action": "cancel" })
    );
}

// --- elicitation/create parsing (claude-agent-acp AskUserQuestion) --------

#[test]
fn parses_single_choice_elicitation() {
    // Shape produced by claude-agent-acp elicitation.ts for one question:
    // message carries the prompt; question_0 is a titled oneOf whose `const`
    // is the option label; question_0_custom is the free-text "Other" box.
    let params = json!({
        "mode": "form",
        "message": "Which approach do you prefer?",
        "requestedSchema": {
            "type": "object",
            "properties": {
                "question_0": {
                    "type": "string",
                    "oneOf": [
                        { "const": "Refactor", "title": "Refactor — rewrite in place" },
                        { "const": "Rewrite", "title": "Rewrite" }
                    ]
                },
                "question_0_custom": {
                    "type": "string",
                    "title": "Other",
                    "description": "Type your own answer."
                }
            }
        }
    });
    let elic = parse_acp_elicitation(&params, &None).expect("single-choice form is parseable");
    assert_eq!(elic.questions.len(), 1);
    let q = &elic.questions[0];
    assert_eq!(q.prompt, "Which approach do you prefer?");
    assert_eq!(q.field_name, "question_0");
    assert_eq!(q.options.len(), 2);
    // const == label == option_id: the frontend submits the label and we
    // write it back as content[content_field] for the enum match.
    assert_eq!(q.options[0].option_id, "Refactor");
    assert_eq!(q.options[0].label, "Refactor");
    // Description folds out of the flattened "label — description" title.
    assert_eq!(
        q.options[0].description.as_deref(),
        Some("rewrite in place")
    );
    assert_eq!(q.options[1].description, None);
}

#[test]
fn parses_multi_question_elicitation_with_real_prompts() {
    // AskUserQuestion with multiple questions: each question_<n> field
    // has a `description` containing the actual question text. The generic
    // `message` is "Please answer the following questions." and should
    // NOT be used as the prompt.
    let params = json!({
        "mode": "form",
        "message": "Please answer the following questions.",
        "requestedSchema": {
            "type": "object",
            "properties": {
                "question_1": {
                    "type": "string",
                    "description": "What deployment target?",
                    "oneOf": [
                        { "const": "K8s", "title": "Kubernetes" },
                        { "const": "VM", "title": "Virtual Machine" }
                    ]
                },
                "question_2": {
                    "type": "string",
                    "description": "What scaling strategy?",
                    "oneOf": [
                        { "const": "Auto", "title": "Auto-scaling" },
                        { "const": "Manual", "title": "Manual" }
                    ]
                }
            }
        }
    });
    let elic = parse_acp_elicitation(&params, &None).expect("multi-question form is parseable");
    assert_eq!(elic.questions.len(), 2);
    assert_eq!(elic.questions[0].prompt, "What deployment target?");
    assert_eq!(elic.questions[0].field_name, "question_1");
    assert_eq!(elic.questions[0].options.len(), 2);
    assert_eq!(elic.questions[0].options[0].option_id, "K8s");
    assert_eq!(elic.questions[1].prompt, "What scaling strategy?");
    assert_eq!(elic.questions[1].field_name, "question_2");
}

#[test]
fn parses_multi_question_elicitation_with_stored_prompts() {
    let params = json!({
        "mode": "form",
        "message": "Please answer the following questions.",
        "requestedSchema": {
            "type": "object",
            "properties": {
                "question_1": {
                    "type": "string",
                    "title": "问题1",
                    "oneOf": [{ "const": "A" }]
                },
                "question_2": {
                    "type": "string",
                    "title": "问题2",
                    "oneOf": [{ "const": "B" }]
                }
            }
        }
    });
    let stored_prompts = Some(vec![
        "你系统部署的方式是什么".to_string(),
        "你要部署到 K8s 的工作负载是什么类型？".to_string(),
    ]);
    let elic =
        parse_acp_elicitation(&params, &stored_prompts).expect("multi-question form is parseable");
    assert_eq!(elic.questions.len(), 2);
    assert_eq!(elic.questions[0].prompt, "你系统部署的方式是什么");
    assert_eq!(
        elic.questions[1].prompt,
        "你要部署到 K8s 的工作负载是什么类型？"
    );
}

#[test]
fn parses_multi_select_anyof_enum() {
    let params = json!({
        "mode": "form",
        "message": "Pick all that apply",
        "requestedSchema": {
            "type": "object",
            "properties": {
                "question_0": {
                    "type": "array",
                    "items": {
                        "anyOf": [
                            { "const": "A", "title": "A" },
                            { "const": "B", "title": "B" }
                        ]
                    }
                }
            }
        }
    });
    let elic = parse_acp_elicitation(&params, &None).expect("array/anyOf is parseable");
    assert_eq!(elic.questions.len(), 1);
    let q = &elic.questions[0];
    assert_eq!(q.options.len(), 2);
    assert_eq!(
        q.options.iter().map(|o| &o.label).collect::<Vec<_>>(),
        ["A", "B"]
    );
}

#[test]
fn url_mode_elicitation_is_not_renderable() {
    let params = json!({ "mode": "url", "url": "https://example/auth", "message": "Sign in" });
    assert!(parse_acp_elicitation(&params, &None).is_none());
}

#[test]
fn elicitation_without_enum_is_not_renderable() {
    // Arbitrary MCP form schema (no oneOf/anyOf) cannot become A/B/C options.
    let params = json!({
        "mode": "form",
        "message": "Name?",
        "requestedSchema": {
            "type": "object",
            "properties": { "question_0": { "type": "string", "title": "Name" } }
        }
    });
    assert!(parse_acp_elicitation(&params, &None).is_none());
}

#[test]
fn elicitation_prefers_structured_description_over_flattened_title() {
    let params = json!({
        "mode": "form",
        "message": "q",
        "requestedSchema": {
            "type": "object",
            "properties": {
                "question_0": {
                    "type": "string",
                    "oneOf": [{
                        "const": "A",
                        "title": "A — flattened desc",
                        "_meta": { "_claude/askUserQuestionOption": { "description": "structured desc", "preview": "p" } }
                    }]
                }
            }
        }
    });
    let elic = parse_acp_elicitation(&params, &None).unwrap();
    assert_eq!(elic.questions.len(), 1);
    assert_eq!(
        elic.questions[0].options[0].description.as_deref(),
        Some("structured desc")
    );
}

#[test]
fn question_field_discriminator_skips_custom_companion() {
    assert!(is_question_field("question_0"));
    assert!(is_question_field("question_12"));
    assert!(!is_question_field("question_0_custom"));
    assert!(!is_question_field("question_"));
    assert!(!is_question_field("question_abc"));
    assert!(!is_question_field("other"));
}

#[test]
fn server_request_with_colliding_id_is_not_a_prompt_response() {
    // Regression: a server-initiated REQUEST (e.g. elicitation/create) whose
    // `id` happens to equal the client's current prompt_id must NOT be
    // misrouted as a prompt response. JSON-RPC responses have `result` or
    // `error` and NO `method`; requests have a `method` field.
    let prompt_id: i64 = 3;

    // A legitimate prompt response (no method, has result) → should match.
    let response =
        json!({ "jsonrpc": "2.0", "id": prompt_id, "result": { "stopReason": "end_turn" } });
    let is_response = response.get("method").is_none();
    assert!(
        is_response,
        "prompt response must be classified as response"
    );

    // An elicitation/create request with the SAME id → must NOT match.
    let elicitation = json!({
        "jsonrpc": "2.0",
        "id": prompt_id,
        "method": "elicitation/create",
        "params": {
            "mode": "form",
            "message": "Pick one",
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "question_0": {
                        "type": "string",
                        "oneOf": [
                            { "const": "A", "title": "A" },
                            { "const": "B", "title": "B" }
                        ]
                    }
                }
            }
        }
    });
    let is_response = elicitation.get("method").is_none();
    assert!(
        !is_response,
        "elicitation/create request must NOT be classified as response"
    );

    // Verify the elicitation is still parseable even when its id collides.
    let params = elicitation.get("params").unwrap();
    let elic = parse_acp_elicitation(params, &None).expect("elicitation should be parseable");
    assert_eq!(elic.questions.len(), 1);
    assert_eq!(elic.questions[0].options.len(), 2);
}

#[test]
fn parse_then_route_yields_enum_matching_content() {
    // End-to-end shape: an elicitation is parsed, registered, and the user's
    // submitted label is routed back as content[question_0] — exactly the
    // shape claude-agent-acp's applyAskElicitationResponse matches against
    // the oneOf const (= the option label).
    let params = json!({
        "mode": "form",
        "message": "Choose",
        "requestedSchema": {
            "type": "object",
            "properties": {
                "question_0": {
                    "type": "string",
                    "oneOf": [
                        { "const": "A", "title": "A" },
                        { "const": "B", "title": "B" }
                    ]
                }
            }
        }
    });
    let elic = parse_acp_elicitation(&params, &None).unwrap();

    let mut pending: HashMap<String, PendingElicitation> = HashMap::new();
    pending.insert(
        "req_1".to_string(),
        PendingElicitation {
            rpc_id: json!(42),
            questions: elic.questions.clone(),
            current_index: 0,
            answers: serde_json::Map::new(),
        },
    );

    match route_acp_interaction_response(&mut pending, "req_1_0", "B") {
        AcpInteractionRoute::Elicit {
            rpc_id,
            action,
            content,
        } => {
            assert_eq!(rpc_id, json!(42));
            assert_eq!(action, ElicitAction::Accept);
            assert_eq!(content, json!({ "question_0": "B" }));
            assert_eq!(
                elicit_result_payload(action, content),
                json!({ "action": "accept", "content": { "question_0": "B" } })
            );
        }
        _ => panic!("expected Elicit route"),
    }
}

// 拆分后补充：兄弟模块中被测项（原同模块可见）
use super::elicitation::{is_question_field, parse_acp_elicitation, AcpQuestion};
use super::interaction::{
    elicit_result_payload, parse_sub_request_id, AcpInteractionRoute, ElicitAction,
    PendingElicitation, PendingPermission,
};
use super::normalize::acp_unexpected_eof_error;
use super::protocol::handle_prompt_response;
