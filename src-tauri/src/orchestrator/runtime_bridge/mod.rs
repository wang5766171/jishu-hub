use std::future::Future;
use std::pin::Pin;
use std::sync::{atomic::AtomicBool, Arc};

use tokio::sync::mpsc;

use crate::acp_runtime::AcpEventEmit;
use crate::agent::normalized::{ContentBlock, NormalizedEvent, TurnEndReason};
use crate::agent::{AgentCapabilities, AgentRegistry, TransportSurface};
use crate::agent_runtime::{AgentTurnOutput, AgentTurnRequest};
use crate::orchestrator::domain::graph::GraphNode;
use crate::orchestrator::domain::run::{
    AgentAssignment, AttemptError, AttemptUsage, ErrorCategory,
};

/// A single item produced by a streaming runtime invocation.
///
/// M1 contract: `TaskAgentRuntime::invoke` returns a stream of these instead of
/// a single collected `AgentTurnOutput`. The orchestrator consumes events as they
/// arrive, can pause on `Event(ApprovalRequest|InteractionRequest)`, and is
/// signalled completion by `Finished`. `RuntimeError` preserves the old
/// "invoke-level Err" path (mapped to a retryable Transient attempt error).
#[derive(Debug, Clone)]
pub enum RuntimeStreamItem {
    /// One normalized transport event (progress/approval/interaction/session/turn-complete/error/...).
    Event(NormalizedEvent),
    /// The runtime could not run the turn at all (equivalent to the legacy invoke `Err`).
    RuntimeError(String),
    /// The underlying process finished (equivalent to legacy `AgentTurnOutput.exit_success/exit_code`).
    /// Terminates the stream.
    Finished {
        exit_success: bool,
        exit_code: Option<i32>,
    },
}

/// Bridge a legacy blocking `AgentTurnOutput` into a sequence of stream items:
/// each event as `Event`, followed by one `Finished`. Used by the blocking-backed
/// `DefaultTaskAgentRuntime` (M1.1, behavior-equivalent) and by tests; M1.4+
/// transports emit items directly.
pub(crate) fn bridge_output_to_stream_items(output: AgentTurnOutput) -> Vec<RuntimeStreamItem> {
    let AgentTurnOutput {
        events,
        exit_success,
        exit_code,
    } = output;
    let mut items: Vec<RuntimeStreamItem> =
        events.into_iter().map(RuntimeStreamItem::Event).collect();
    items.push(RuntimeStreamItem::Finished {
        exit_success,
        exit_code,
    });
    items
}

/// Handle to a running invocation. `events` is consumed item-by-item by the
/// orchestrator; the stream terminates after `Finished` (or `RuntimeError`).
pub struct InvocationHandle {
    pub invocation_id: String,
    pub events: mpsc::Receiver<RuntimeStreamItem>,
}

/// Materialize a one-shot `Result<AgentTurnOutput, String>` (the legacy blocking
/// shape) into a streaming `InvocationHandle`. Used by the blocking-backed
/// `DefaultTaskAgentRuntime` and by in-process test runtimes. Real transports
/// (M1.4+) emit items directly without going through this bridge.
pub(crate) fn materialize_handle(
    invocation_id: String,
    result: Result<AgentTurnOutput, String>,
) -> InvocationHandle {
    let (tx, rx) = mpsc::channel::<RuntimeStreamItem>(64);
    tokio::task::spawn_blocking(move || match result {
        Ok(output) => {
            for item in bridge_output_to_stream_items(output) {
                if tx.blocking_send(item).is_err() {
                    return;
                }
            }
        }
        Err(message) => {
            let _ = tx.blocking_send(RuntimeStreamItem::RuntimeError(message));
        }
    });
    InvocationHandle {
        invocation_id,
        events: rx,
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeInvocationRequest {
    /// Stable id for this invocation; used for `cancel(invocation_id)` and audit.
    pub invocation_id: String,
    pub agent_id: String,
    pub role_id: String,
    pub project_path: String,
    pub session_id: Option<String>,
    pub prompt: String,
    pub timeout_ms: u64,
    pub cancellation: Arc<AtomicBool>,
}

pub trait TaskAgentRuntime: Send + Sync {
    fn resolve_agent(
        &self,
        node: &GraphNode,
        role_id: &str,
    ) -> Result<(AgentAssignment, String), String>;

    /// Start a turn and return immediately with a streaming handle. The caller
    /// consumes `handle.events` until termination. The returned future resolves
    /// once the invocation has been launched; execution results arrive via the
    /// stream (`RuntimeStreamItem`).
    fn invoke(
        &self,
        request: RuntimeInvocationRequest,
    ) -> Pin<Box<dyn Future<Output = Result<InvocationHandle, String>> + Send>>;

    /// Request cancellation of an in-flight invocation by id. Default no-op;
    /// runtimes that track live invocations override this (M1.2+).
    fn cancel(&self, _invocation_id: &str) {}

    /// Steer an in-flight invocation (mid-turn text injection). Default no-op;
    /// PiRpc overrides to send a `Prompt` (steer) command to the live session.
    fn steer(&self, _invocation_id: &str, _message: String) -> Result<(), String> {
        Err("steer not supported by this runtime".to_string())
    }
}

pub struct DefaultTaskAgentRuntime {
    registry: Arc<AgentRegistry>,
    /// Live Pi RPC sessions keyed by invocation_id. Used for mid-turn steering/cancel.
    live_controls:
        Arc<std::sync::Mutex<std::collections::HashMap<String, crate::acp_runtime::AcpControl>>>,
}

impl DefaultTaskAgentRuntime {
    pub fn new(registry: Arc<AgentRegistry>) -> Self {
        Self {
            registry,
            live_controls: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }
}

impl TaskAgentRuntime for DefaultTaskAgentRuntime {
    fn resolve_agent(
        &self,
        node: &GraphNode,
        role_id: &str,
    ) -> Result<(AgentAssignment, String), String> {
        let (assignment, transport) = resolve_agent_assignment(&self.registry, node, role_id)?;
        Ok((assignment, transport.as_str().to_string()))
    }

    fn invoke(
        &self,
        request: RuntimeInvocationRequest,
    ) -> Pin<Box<dyn Future<Output = Result<InvocationHandle, String>> + Send>> {
        let registry = self.registry.clone();
        let live_controls = self.live_controls.clone();
        Box::pin(async move {
            let invocation_id = request.invocation_id.clone();

            // Resolve transport to decide: persistent (PiRpc) vs blocking (ACP/CLI).
            let agent = registry
                .get(&request.agent_id)
                .ok_or_else(|| format!("Agent not found: {}", request.agent_id))?;
            let transport = agent.resolve_transport();

            if transport == TransportSurface::PiRpc {
                // === Persistent Pi RPC session (real-time streaming) ===
                // Unlike the blocking path (which buffers all events until the turn
                // ends), the persistent session streams events live. This lets the
                // planner/conversation panel show the agent's text + thinking in
                // real-time and allows mid-turn steering.
                let req = crate::agent::ChatRequest {
                    project_path: request.project_path.clone(),
                    session_id: request.session_id.clone(),
                    message: request.prompt.clone(),
                };
                let acp_command = agent
                    .build_acp_command(&req)
                    .map_err(|e| format!("Failed to build Pi RPC command: {e}"))?;

                let mut command = tokio::process::Command::new(&acp_command.program);
                command.args(&acp_command.args);
                command.current_dir(&request.project_path);
                for (key, value) in &acp_command.envs {
                    command.env(key, value);
                }
                command.stdin(std::process::Stdio::piped());
                command.stdout(std::process::Stdio::piped());
                command.stderr(std::process::Stdio::piped());

                #[cfg(target_os = "windows")]
                {
                    crate::process_command::tokio_no_window(&mut command);
                }

                let child = command
                    .spawn()
                    .map_err(|e| format!("Failed to spawn Pi RPC process: {e}"))?;

                // Create event channel + callback emitter.
                let (event_tx, mut event_rx) =
                    tokio::sync::mpsc::unbounded_channel::<NormalizedEvent>();
                let emit: AcpEventEmit = Arc::new(move |events: &[NormalizedEvent], _| {
                    for event in events {
                        let _ = event_tx.send(event.clone());
                    }
                });

                let pending_session_id = request
                    .session_id
                    .clone()
                    .unwrap_or_else(|| format!("orchestrator-{invocation_id}"));

                // Spawn the persistent session. Returns immediately with AcpControl.
                let acp_control = crate::pi_rpc_runtime::spawn_pi_rpc_session_with_emitter(
                    emit,
                    pending_session_id,
                    child,
                    request.prompt,
                    agent.resolved_session_prompt_injection(),
                    || {},
                    |_sid| {},
                );

                // Register the control for mid-turn steering, then move a clone
                // into the bridge. The original is removed when the bridge ends.
                {
                    let mut guard = live_controls.lock().map_err(|e| e.to_string())?;
                    guard.insert(invocation_id.clone(), acp_control.clone());
                }
                let steer_invocation_id = invocation_id.clone();

                let (stream_tx, stream_rx) = mpsc::channel::<RuntimeStreamItem>(64);
                tokio::spawn(async move {
                    let _keep_alive = acp_control;
                    let mut finished = false;
                    while let Some(event) = event_rx.recv().await {
                        let is_complete = matches!(event, NormalizedEvent::TurnComplete { .. });
                        if stream_tx
                            .send(RuntimeStreamItem::Event(event))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        if is_complete && !finished {
                            finished = true;
                            let _ = stream_tx
                                .send(RuntimeStreamItem::Finished {
                                    exit_success: true,
                                    exit_code: Some(0),
                                })
                                .await;
                            break;
                        }
                    }
                    if !finished {
                        let _ = stream_tx
                            .send(RuntimeStreamItem::Finished {
                                exit_success: false,
                                exit_code: None,
                            })
                            .await;
                    }
                    // Clean up: remove from live registry so steer() fails fast.
                    if let Ok(mut guard) = live_controls.lock() {
                        guard.remove(&steer_invocation_id);
                    }
                });

                Ok(InvocationHandle {
                    invocation_id,
                    events: stream_rx,
                })
            } else {
                // === Blocking path (ACP / CLI) ===
                let timeout_ms = request.timeout_ms;
                let cancellation = request.cancellation.clone();
                let result = tokio::task::spawn_blocking(move || {
                    crate::agent_runtime::run_turn_blocking_cancellable(
                        &registry,
                        AgentTurnRequest {
                            agent_id: request.agent_id,
                            project_path: request.project_path,
                            session_id: request.session_id,
                            message: request.prompt,
                            timeout_secs: (timeout_ms.saturating_add(999) / 1000).max(1),
                        },
                        None,
                        Some(cancellation),
                    )
                })
                .await
                .map_err(|error| format!("agent runtime task failed: {error}"))?;
                Ok(materialize_handle(invocation_id, result))
            }
        })
    }

    fn steer(&self, invocation_id: &str, message: String) -> Result<(), String> {
        let guard = self.live_controls.lock().map_err(|e| e.to_string())?;
        let control = guard
            .get(invocation_id)
            .ok_or_else(|| format!("No live session for invocation {invocation_id}"))?;
        let control = control.clone();
        drop(guard);
        tauri::async_runtime::block_on(async move {
            control
                .steer(message)
                .await
                .map_err(|e| format!("Steer failed: {e}"))
        })
    }

    fn cancel(&self, invocation_id: &str) {
        let control = self
            .live_controls
            .lock()
            .ok()
            .and_then(|guard| guard.get(invocation_id).cloned());
        if let Some(control) = control {
            tauri::async_runtime::spawn(async move {
                control.send_cancel().await;
            });
        }
    }
}

pub fn resolve_agent_assignment(
    registry: &AgentRegistry,
    node: &GraphNode,
    role_id: &str,
) -> Result<(AgentAssignment, TransportSurface), String> {
    let constraint = node.agent_assignment_constraint.as_ref();
    let required = node
        .role_requirement
        .iter()
        .flat_map(|role| role.required_capabilities.iter())
        .chain(node.capability_requirements.iter())
        .map(|capability| capability.to_ascii_lowercase())
        .collect::<Vec<_>>();

    let mut candidates = registry.list_agents();
    let active_id = registry.active_id();
    candidates.sort_by_key(|agent| if agent.id == active_id { 0 } else { 1 });

    if let Some(locked_agent_id) = constraint.and_then(|value| value.locked_agent_id.as_ref()) {
        candidates.retain(|agent| &agent.id == locked_agent_id);
    }
    if let Some(constraint) = constraint {
        if !constraint.allowed_agent_ids.is_empty() {
            candidates.retain(|agent| constraint.allowed_agent_ids.contains(&agent.id));
        }
        candidates.retain(|agent| !constraint.denied_agent_ids.contains(&agent.id));
    }

    for candidate in candidates {
        let Some(adapter) = registry.get(&candidate.id) else {
            continue;
        };
        let capabilities = adapter.capabilities();
        if required
            .iter()
            .all(|required| supports_capability(capabilities, required))
        {
            return Ok((
                AgentAssignment {
                    agent_id: candidate.id,
                    role_id: role_id.to_string(),
                    adapter_capability_snapshot: capability_snapshot(capabilities),
                },
                adapter.resolve_transport(),
            ));
        }
    }

    Err(format!(
        "no agent satisfies role {role_id} with capabilities [{}]",
        required.join(", ")
    ))
}

fn supports_capability(capabilities: AgentCapabilities, required: &str) -> bool {
    capability_flag(required)
        .map(|flag| capabilities.contains(flag))
        .unwrap_or(false)
}

fn capability_flag(name: &str) -> Option<AgentCapabilities> {
    Some(match name {
        "resume_by_id" => AgentCapabilities::RESUME_BY_ID,
        "resume_latest" => AgentCapabilities::RESUME_LATEST,
        "session_fork" => AgentCapabilities::SESSION_FORK,
        "image_input" => AgentCapabilities::IMAGE_INPUT,
        "file_input" => AgentCapabilities::FILE_INPUT,
        "stdin_prompt" => AgentCapabilities::STDIN_PROMPT,
        "stream_text_delta" => AgentCapabilities::STREAM_TEXT_DELTA,
        "stream_tool_calls" | "tool_use" => AgentCapabilities::STREAM_TOOL_CALLS,
        "stream_thinking" => AgentCapabilities::STREAM_THINKING,
        "abort" | "cancellation" => AgentCapabilities::ABORT,
        "approval_request" => AgentCapabilities::APPROVAL_REQUEST,
        "pre_execution_interception" => AgentCapabilities::PRE_EXECUTION_INTERCEPTION,
        "subagent_dispatch" => AgentCapabilities::SUBAGENT_DISPATCH,
        "task_planning" => AgentCapabilities::TASK_PLANNING,
        "task_supervision" => AgentCapabilities::TASK_SUPERVISION,
        "rpc_bidirectional" => AgentCapabilities::RPC_BIDIRECTIONAL,
        _ => return None,
    })
}

pub(crate) fn capability_snapshot(capabilities: AgentCapabilities) -> Vec<String> {
    [
        "resume_by_id",
        "resume_latest",
        "session_fork",
        "image_input",
        "file_input",
        "stdin_prompt",
        "stream_text_delta",
        "stream_tool_calls",
        "stream_thinking",
        "abort",
        "approval_request",
        "pre_execution_interception",
        "subagent_dispatch",
        "task_planning",
        "task_supervision",
        "rpc_bidirectional",
    ]
    .into_iter()
    .filter(|name| supports_capability(capabilities, name))
    .map(str::to_string)
    .collect()
}

#[derive(Debug, Clone)]
pub struct RuntimeEventContext {
    pub run_id: String,
    pub node_run_id: String,
    pub attempt_id: String,
}

#[derive(Debug, Clone)]
pub enum RuntimeFact {
    Progress {
        context: RuntimeEventContext,
        message: String,
        usage_delta: AttemptUsage,
    },
    ApprovalRequested {
        context: RuntimeEventContext,
        request_id: String,
        approval_kind: String,
        payload: serde_json::Value,
    },
    InteractionRequested {
        context: RuntimeEventContext,
        request_id: String,
        prompt: String,
        options: Vec<crate::agent::normalized::InteractionOption>,
        allow_multiple: bool,
        allow_custom_text: bool,
        required: bool,
    },
    SessionResolved {
        context: RuntimeEventContext,
        session_id: String,
    },
    Completed {
        context: RuntimeEventContext,
        usage: AttemptUsage,
    },
    Failed {
        context: RuntimeEventContext,
        error: AttemptError,
    },
    Diagnostic {
        context: RuntimeEventContext,
        payload: serde_json::Value,
    },
}

pub fn map_normalized_event(context: &RuntimeEventContext, event: &NormalizedEvent) -> RuntimeFact {
    match event {
        NormalizedEvent::TextDelta { delta } => RuntimeFact::Progress {
            context: context.clone(),
            message: delta.clone(),
            usage_delta: AttemptUsage::default(),
        },
        NormalizedEvent::Message { content } => {
            let message = content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            if message.is_empty() {
                RuntimeFact::Diagnostic {
                    context: context.clone(),
                    payload: serde_json::json!({ "kind": "non_text_message" }),
                }
            } else {
                RuntimeFact::Progress {
                    context: context.clone(),
                    message,
                    usage_delta: AttemptUsage::default(),
                }
            }
        }
        NormalizedEvent::Thinking { delta } => RuntimeFact::Diagnostic {
            context: context.clone(),
            payload: serde_json::json!({
                "kind": "thinking",
                "delta": delta,
            }),
        },
        NormalizedEvent::ToolUseStart {
            call_id,
            tool,
            input,
        } => RuntimeFact::Diagnostic {
            context: context.clone(),
            payload: serde_json::json!({
                "kind": "tool_use_start",
                "call_id": call_id,
                "tool": tool,
                "input": input,
            }),
        },
        NormalizedEvent::ToolUseResult {
            call_id,
            output,
            is_error,
        } => RuntimeFact::Diagnostic {
            context: context.clone(),
            payload: serde_json::json!({
                "kind": "tool_use_result",
                "call_id": call_id,
                "output": output,
                "is_error": is_error,
            }),
        },
        NormalizedEvent::ApprovalRequest {
            request_id,
            approval_kind,
            payload,
        } => RuntimeFact::ApprovalRequested {
            context: context.clone(),
            request_id: request_id.clone(),
            approval_kind: format!("{approval_kind:?}").to_lowercase(),
            payload: payload.clone(),
        },
        NormalizedEvent::SessionResolved { session_id } => RuntimeFact::SessionResolved {
            context: context.clone(),
            session_id: session_id.clone(),
        },
        NormalizedEvent::TurnComplete { reason, usage } => {
            let usage = usage
                .as_ref()
                .map(|usage| AttemptUsage {
                    input_tokens: usage.input_tokens.unwrap_or_default(),
                    output_tokens: usage.output_tokens.unwrap_or_default(),
                    cost_usd: usage.total_cost.unwrap_or_default(),
                })
                .unwrap_or_default();
            match reason {
                TurnEndReason::Complete => RuntimeFact::Completed {
                    context: context.clone(),
                    usage,
                },
                TurnEndReason::Aborted | TurnEndReason::Error | TurnEndReason::MaxTokens => {
                    RuntimeFact::Failed {
                        context: context.clone(),
                        error: AttemptError {
                            category: if matches!(reason, TurnEndReason::MaxTokens) {
                                ErrorCategory::Policy
                            } else {
                                ErrorCategory::Transient
                            },
                            message: format!("agent turn ended with {reason:?}"),
                            retryable: matches!(reason, TurnEndReason::Error),
                            retry_after_ms: None,
                            provider_detail: None,
                        },
                    }
                }
            }
        }
        NormalizedEvent::Error {
            message,
            recoverable,
        } => RuntimeFact::Failed {
            context: context.clone(),
            error: AttemptError {
                category: if *recoverable {
                    ErrorCategory::Transient
                } else {
                    ErrorCategory::Deterministic
                },
                message: message.clone(),
                retryable: *recoverable,
                retry_after_ms: None,
                provider_detail: None,
            },
        },
        NormalizedEvent::InteractionRequest {
            request_id,
            prompt,
            options,
            allow_multiple,
            allow_custom_text,
            required,
            ..
        } => RuntimeFact::InteractionRequested {
            context: context.clone(),
            request_id: request_id.clone(),
            prompt: prompt.clone(),
            options: options.clone(),
            allow_multiple: *allow_multiple,
            allow_custom_text: *allow_custom_text,
            required: *required,
        },
        NormalizedEvent::TaskStep { .. }
        | NormalizedEvent::SubAgentDispatch { .. }
        | NormalizedEvent::SteerInjected { .. }
        | NormalizedEvent::Raw { .. }
        | NormalizedEvent::PhaseDivider { .. } => RuntimeFact::Diagnostic {
            context: context.clone(),
            payload: serde_json::to_value(event).unwrap_or_default(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::normalized::UsageStats;
    use crate::orchestrator::domain::graph::{AgentAssignmentConstraint, GraphNode, NodeKind};

    fn dispatch_node() -> GraphNode {
        GraphNode {
            node_id: "dispatch".into(),
            parent_id: None,
            title: "Dispatch".into(),
            description: None,
            node_kind: NodeKind::Executable,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: Default::default(),
            executable_payload: None,
            loop_config: None,
            approval_gate_config: None,
        }
    }

    #[test]
    fn assignment_honors_structured_agent_lock() {
        let registry = AgentRegistry::new();
        let mut node = dispatch_node();
        node.agent_assignment_constraint = Some(AgentAssignmentConstraint {
            role_id: "implementer".into(),
            locked_agent_id: Some("codex".into()),
            ..Default::default()
        });

        let (assignment, transport) =
            resolve_agent_assignment(&registry, &node, "implementer").unwrap();

        assert_eq!(assignment.agent_id, "codex");
        assert_eq!(assignment.role_id, "implementer");
        // codex's transport surface is now the app-server (interactive path);
        // the autonomous dispatch path internally falls back to CLI exec.
        assert_eq!(transport, TransportSurface::CodexAppServer);
    }

    #[test]
    fn assignment_rejects_unknown_required_capability() {
        let registry = AgentRegistry::new();
        let mut node = dispatch_node();
        node.capability_requirements = vec!["nonexistent_capability".into()];

        assert!(resolve_agent_assignment(&registry, &node, "implementer").is_err());
    }

    #[test]
    fn pre_execution_interception_capability_resolves() {
        assert_eq!(
            capability_flag("pre_execution_interception"),
            Some(AgentCapabilities::PRE_EXECUTION_INTERCEPTION)
        );
        let snapshot = capability_snapshot(AgentCapabilities::PRE_EXECUTION_INTERCEPTION);
        assert!(snapshot.contains(&"pre_execution_interception".to_string()));
    }

    #[test]
    fn task_planning_capability_resolves_through_adapter_contract() {
        let registry = AgentRegistry::new();
        let mut node = dispatch_node();
        node.capability_requirements = vec!["task_planning".into()];

        let (assignment, transport) =
            resolve_agent_assignment(&registry, &node, "planner").unwrap();

        assert_eq!(assignment.role_id, "planner");
        assert!(assignment
            .adapter_capability_snapshot
            .contains(&"task_planning".to_string()));
        assert_eq!(transport, TransportSurface::PiRpc);
    }

    #[test]
    fn completed_turn_maps_usage_with_attempt_context() {
        let context = RuntimeEventContext {
            run_id: "run1".into(),
            node_run_id: "node-run1".into(),
            attempt_id: "attempt1".into(),
        };
        let fact = map_normalized_event(
            &context,
            &NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                usage: Some(UsageStats {
                    input_tokens: Some(10),
                    output_tokens: Some(20),
                    total_cost: Some(0.25),
                    context_remaining: None,
                }),
            },
        );
        match fact {
            RuntimeFact::Completed { context, usage } => {
                assert_eq!(context.attempt_id, "attempt1");
                assert_eq!(usage.input_tokens, 10);
                assert_eq!(usage.output_tokens, 20);
                assert_eq!(usage.cost_usd, 0.25);
            }
            _ => panic!("expected completed runtime fact"),
        }
    }

    #[test]
    fn bridge_output_emits_events_then_finished() {
        let output = AgentTurnOutput {
            events: vec![
                NormalizedEvent::TextDelta { delta: "hi".into() },
                NormalizedEvent::TurnComplete {
                    reason: TurnEndReason::Complete,
                    usage: Some(UsageStats {
                        input_tokens: Some(1),
                        output_tokens: Some(2),
                        total_cost: Some(0.1),
                        context_remaining: None,
                    }),
                },
            ],
            exit_success: true,
            exit_code: Some(0),
        };
        let items = bridge_output_to_stream_items(output);
        assert_eq!(items.len(), 3);
        assert!(matches!(
            items[0],
            RuntimeStreamItem::Event(NormalizedEvent::TextDelta { .. })
        ));
        assert!(matches!(
            items[1],
            RuntimeStreamItem::Event(NormalizedEvent::TurnComplete { .. })
        ));
        assert!(matches!(
            items[2],
            RuntimeStreamItem::Finished {
                exit_success: true,
                exit_code: Some(0)
            }
        ));
    }

    #[tokio::test]
    async fn materialized_handle_streams_events_then_finished() {
        let output: Result<AgentTurnOutput, String> = Ok(AgentTurnOutput {
            events: vec![NormalizedEvent::TextDelta { delta: "x".into() }],
            exit_success: true,
            exit_code: Some(0),
        });
        let mut handle = materialize_handle("inv-1".into(), output);
        assert_eq!(handle.invocation_id, "inv-1");
        let mut items = Vec::new();
        while let Some(item) = handle.events.recv().await {
            items.push(item);
        }
        assert_eq!(items.len(), 2);
        assert!(matches!(
            items[0],
            RuntimeStreamItem::Event(NormalizedEvent::TextDelta { .. })
        ));
        assert!(matches!(
            items[1],
            RuntimeStreamItem::Finished {
                exit_success: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn materialized_handle_propagates_runtime_error() {
        let mut handle = materialize_handle("inv-2".into(), Err("boom".to_string()));
        let mut items = Vec::new();
        while let Some(item) = handle.events.recv().await {
            items.push(item);
        }
        assert_eq!(items.len(), 1);
        assert!(matches!(
            items[0],
            RuntimeStreamItem::RuntimeError(ref msg) if msg == "boom"
        ));
    }
}
