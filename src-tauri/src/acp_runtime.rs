//! Tauri-internal ACP runtime: manages agent subprocess lifecycle within the
//! desktop app. Uses mpsc channels for in-process communication between the
//! Tauri webview and spawned agent CLIs.
//!
//! This is distinct from `acp/` which implements the stdio JSON-RPC 2.0
//! **external** protocol (per `protocols-spec.md §7`) for editor integrations
//! (Zed, JetBrains). This module is the **internal** consumer that spawns
//! agents and relays their NormalizedEvent streams to the GUI.

use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

use crate::agent::normalized::{
    interaction_requests_from_tool_call, is_elicitation_only_tool, InteractionCorrelation,
    InteractionDeliveryHint, InteractionOption, InteractionOrigin, InteractionTransport,
    NormalizedEvent, TurnEndReason, UsageStats,
};
use crate::cli_runtime::AgentStreamChunk;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Commands sent to the persistent ACP connection task.
pub enum AcpCommand {
    Prompt(String),
    /// Steer (mid-turn text injection). Pi RPC: sends {"type":"steer","message":...}.
    /// ACP: sends a follow_up prompt after the current turn.
    Steer(String),
    Cancel,
    /// Respond to a structured interaction answer. Routed by the connection loop
    /// to the transport's mid-turn write-back channel:
    /// - PiRpc → `extension_ui_response` (production mid-turn baseline).
    /// - ACP   → a pending `elicitation/create` (claude_code, capability-gated;
    ///           populated in Phase 3). ACP agents without an elicitation channel
    ///           (opencode) have no mid-turn business path and must be answered
    ///           as a follow-up message (handled by the frontend, not here).
    /// `id` is the interaction request id; `value` is the user's choice/input.
    /// `response` carries the write-back outcome so the caller reports an
    /// authoritative `InteractionDelivery` (design R6).
    RespondToInput {
        id: String,
        value: String,
        response: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    ResolvePermission {
        request_id: String,
        approved: bool,
        response: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    Shutdown,
}

/// Handle stored in `ChatProcess.acp` for communicating with the connection task.
#[derive(Clone)]
pub struct AcpControl {
    pub(crate) tx: tokio::sync::mpsc::Sender<AcpCommand>,
    pub(crate) acp_session_id: Arc<std::sync::Mutex<Option<String>>>,
}

impl AcpControl {
    pub async fn send_prompt(&self, message: String) -> Result<(), String> {
        self.tx
            .send(AcpCommand::Prompt(message))
            .await
            .map_err(|_| "ACP connection closed".to_string())
    }

    pub fn resolved_session_id(&self) -> Option<String> {
        self.acp_session_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub async fn send_cancel(&self) {
        let _ = self.tx.send(AcpCommand::Cancel).await;
    }

    /// Steer the in-flight turn (mid-turn text injection). For Pi RPC this
    /// sends the native `steer` command; the agent incorporates the text
    /// while continuing the same turn.
    pub async fn steer(&self, message: String) -> Result<(), String> {
        self.tx
            .send(AcpCommand::Steer(message))
            .await
            .map_err(|_| "ACP connection closed".to_string())
    }

    /// Respond to a structured interaction answer (PiRpc `extension_ui`, or ACP
    /// `elicitation/create` for claude_code). Returns the write-back outcome so
    /// the caller can take the authoritative delivery decision (design R6).
    pub async fn respond_to_input(&self, id: String, value: String) -> Result<(), String> {
        let (response, receiver) = tokio::sync::oneshot::channel();
        self.tx
            .send(AcpCommand::RespondToInput {
                id,
                value,
                response,
            })
            .await
            .map_err(|_| "ACP connection closed".to_string())?;
        receiver
            .await
            .map_err(|_| "ACP interaction response channel closed".to_string())?
    }

    pub async fn resolve_permission(
        &self,
        request_id: String,
        approved: bool,
    ) -> Result<(), String> {
        let (response, receiver) = tokio::sync::oneshot::channel();
        self.tx
            .send(AcpCommand::ResolvePermission {
                request_id,
                approved,
                response,
            })
            .await
            .map_err(|_| "ACP connection closed".to_string())?;
        receiver
            .await
            .map_err(|_| "ACP permission response channel closed".to_string())?
    }

    pub async fn shutdown(&self) {
        let _ = self.tx.send(AcpCommand::Shutdown).await;
    }
}

/// Where the ACP connection loop sends its normalized events. A callback (not an
/// enum) decouples the loop from `tauri::AppHandle`: the GUI/chat path supplies a
/// closure that emits Tauri `agent-event` chunks; the orchestrator (no
/// `AppHandle`, design §3.1/D4) supplies a closure that pushes into a channel.
/// A callback is used instead of an enum-with-a-channel-variant because
/// constructing that enum variant in the test binary triggered a Windows
/// toolchain load-time entry-point failure (STATUS_ENTRYPOINT_NOT_FOUND); a
/// plain closure capturing a channel does not.
pub type AcpEventEmit = Arc<dyn Fn(&[NormalizedEvent], &str) + Send + Sync>;

/// Build the GUI/chat event emitter: emits `agent-event` chunks to the webview.
pub fn tauri_event_emitter(app: tauri::AppHandle, agent_id: String) -> AcpEventEmit {
    Arc::new(move |events: &[NormalizedEvent], session_id: &str| {
        let chunks: Vec<AgentStreamChunk> = events
            .iter()
            .filter_map(|event| {
                let data = serde_json::to_value(event).ok()?;
                Some(AgentStreamChunk {
                    agent_id: agent_id.clone(),
                    session_id: session_id.to_string(),
                    event_type: event.event_type().to_string(),
                    data,
                })
            })
            .collect();
        if !chunks.is_empty() {
            let _ = app.emit("agent-event", &chunks);
        }
    })
}

// ---------------------------------------------------------------------------
// Internal: JSON-RPC writer
// ---------------------------------------------------------------------------

struct AcpWriter {
    stdin: Arc<TokioMutex<ChildStdin>>,
    next_id: i64,
}

impl AcpWriter {
    fn new(stdin: Arc<TokioMutex<ChildStdin>>) -> Self {
        Self { stdin, next_id: 0 }
    }

    async fn request(&mut self, method: &str, params: serde_json::Value) -> Result<i64, String> {
        let mut stdin = self.stdin.lock().await;
        write_jsonrpc_request(&mut *stdin, &mut self.next_id, method, params).await
    }

    /// Send a JSON-RPC response for a server-initiated request (e.g. tool approval).
    async fn respond(
        &self,
        id: &serde_json::Value,
        result: serde_json::Value,
    ) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        });
        let line = format!("{}\n", msg);
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("ACP write error: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("ACP flush error: {e}"))?;
        Ok(())
    }
}

pub enum AcpResponse {
    Update(Vec<NormalizedEvent>),
    PermissionRequest {
        id: serde_json::Value,
        params: serde_json::Value,
    },
    Result(serde_json::Value),
    Error(String),
    Ignored,
}

pub async fn write_jsonrpc_request(
    stdin: &mut (impl tokio::io::AsyncWrite + Unpin),
    next_id: &mut i64,
    method: &str,
    params: serde_json::Value,
) -> Result<i64, String> {
    let id = *next_id;
    *next_id += 1;
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params
    });
    let line = format!("{}\n", msg);
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("ACP write error: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("ACP flush error: {e}"))?;
    Ok(id)
}

pub(crate) fn acp_initialize_params() -> serde_json::Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false,
            // ACP SDK 0.26 models elicitation modes as object capabilities.
            // Sending `form: true` is schema-invalid and gets dropped before
            // claude-agent-acp computes its AskUserQuestion gate.
            "elicitation": { "form": {} }
        },
        "clientInfo": {
            "name": "jishu-hub",
            "version": env!("CARGO_PKG_VERSION")
        }
    })
}

pub fn handle_acp_response_line(
    line: &str,
    target_id: i64,
    usage: &mut Option<UsageStats>,
) -> Result<AcpResponse, String> {
    if line.trim().is_empty() {
        return Ok(AcpResponse::Ignored);
    }
    let msg: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("ACP JSON parse error: {e}"))?;

    if msg.get("method").and_then(|v| v.as_str()) == Some("session/update") {
        if let Some(params) = msg.get("params") {
            let events = normalize_acp_update(params, usage);
            return Ok(AcpResponse::Update(events));
        }
    } else if msg.get("method").and_then(|v| v.as_str()) == Some("session/request_permission") {
        let id = msg
            .get("id")
            .cloned()
            .ok_or_else(|| "ACP permission request missing id".to_string())?;
        let params = msg.get("params").cloned().unwrap_or_default();
        return Ok(AcpResponse::PermissionRequest { id, params });
    } else if msg.get("id").and_then(|v| v.as_i64()) == Some(target_id) {
        if let Some(err) = msg.get("error") {
            return Ok(AcpResponse::Error(
                err.get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
            ));
        }
        if let Some(res) = msg.get("result") {
            return Ok(AcpResponse::Result(res.clone()));
        }
        return Err("ACP response missing result or error".to_string());
    }
    Ok(AcpResponse::Ignored)
}

// ---------------------------------------------------------------------------
// Internal: connection loop state machine
// ---------------------------------------------------------------------------

enum LoopState {
    Idle,
    Prompting {
        prompt_id: i64,
    },
    CancelPending {
        old_prompt_id: i64,
        // The JSON-RPC id of the session/cancel request we issued, so the
        // stdout loop can detect when the agent rejects cancel (some ACP
        // servers, e.g. opencode, do not implement session/cancel and reply
        // with an error). Cleared once the cancel is acknowledged.
        cancel_request_id: Option<i64>,
        pending_prompt: Option<String>,
    },
}

const IDLE_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug)]
struct PendingPermission {
    rpc_id: serde_json::Value,
    allow_option_id: Option<String>,
    reject_option_id: Option<String>,
}

/// A pending ACP `elicitation/create` (claude_code business question, capability-
/// gated). Stored in a DISTINCT table from `pending_permissions` (design R3 / §8.2:
/// `pending_permissions` 与 `pending_elicitations` 必须分表) so a business
/// interaction answer can never be mistaken for — or routed to — a tool approval.
#[derive(Debug, Clone)]
struct PendingElicitation {
    rpc_id: serde_json::Value,
    questions: Vec<AcpQuestion>,
    current_index: usize,
    answers: serde_json::Map<String, serde_json::Value>,
}

/// Three-state ACP elicitation response action (protocol `accept`/`decline`/
/// `cancel`). jishu-hub's InteractionComposer only ever submits a chosen answer,
/// so the routed action is `Accept`; `Decline`/`Cancel` are modelled for protocol
/// completeness and future UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ElicitAction {
    Accept,
    Decline,
    Cancel,
}

/// Where a business-interaction answer should be written on ACP. Reads ONLY the
/// elicitations table — by construction business answers never consult the
/// permission table (R3 分表).
#[derive(Debug)]
enum AcpInteractionRoute {
    PendingNext {
        base_id: String,
        next_index: usize,
    },
    /// Map the answer to the pending elicitation's JSON-RPC result.
    Elicit {
        rpc_id: serde_json::Value,
        action: ElicitAction,
        content: serde_json::Value,
    },
    /// No pending ACP business-interaction channel for this request. The agent
    /// (e.g. opencode) has no elicitation path; the answer must be delivered as
    /// a follow-up message, not written back here.
    NoChannel,
}

fn parse_sub_request_id(request_id: &str) -> Option<(&str, usize)> {
    let last_underscore = request_id.rfind('_')?;
    let base_id = &request_id[..last_underscore];
    let index_str = &request_id[last_underscore + 1..];
    let sub_index = index_str.parse::<usize>().ok()?;
    Some((base_id, sub_index))
}

/// Route a business-interaction answer. Consults ONLY `pending_elicitations` —
/// a pending `request_permission` for the same request id is intentionally NOT
/// matched here (R3: business/permission 分表, never cross-consumed).
fn route_acp_interaction_response(
    pending_elicitations: &mut HashMap<String, PendingElicitation>,
    request_id: &str,
    value: &str,
) -> AcpInteractionRoute {
    let Some((base_id, sub_index)) = parse_sub_request_id(request_id) else {
        return match pending_elicitations.get(request_id) {
            Some(pending) => {
                let mut content = serde_json::Map::new();
                if let Some(first_q) = pending.questions.first() {
                    content.insert(
                        first_q.field_name.clone(),
                        serde_json::Value::String(value.to_string()),
                    );
                }
                AcpInteractionRoute::Elicit {
                    rpc_id: pending.rpc_id.clone(),
                    action: ElicitAction::Accept,
                    content: serde_json::Value::Object(content),
                }
            }
            None => AcpInteractionRoute::NoChannel,
        };
    };

    let pending = match pending_elicitations.get_mut(base_id) {
        Some(p) => p,
        None => return AcpInteractionRoute::NoChannel,
    };

    if sub_index < pending.questions.len() {
        let q = &pending.questions[sub_index];
        pending.answers.insert(
            q.field_name.clone(),
            serde_json::Value::String(value.to_string()),
        );
    }

    pending.current_index = sub_index + 1;

    if pending.current_index < pending.questions.len() {
        AcpInteractionRoute::PendingNext {
            base_id: base_id.to_string(),
            next_index: pending.current_index,
        }
    } else {
        let rpc_id = pending.rpc_id.clone();
        let content = serde_json::Value::Object(pending.answers.clone());
        AcpInteractionRoute::Elicit {
            rpc_id,
            action: ElicitAction::Accept,
            content,
        }
    }
}

/// Build the JSON-RPC `result` object for an elicitation write-back.
fn elicit_result_payload(action: ElicitAction, content: serde_json::Value) -> serde_json::Value {
    match action {
        ElicitAction::Accept => serde_json::json!({ "action": "accept", "content": content }),
        ElicitAction::Decline => serde_json::json!({ "action": "decline" }),
        ElicitAction::Cancel => serde_json::json!({ "action": "cancel" }),
    }
}

/// `InteractionCorrelation::request_kind` discriminator for ACP elicitations,
/// so a business-answer correlation can never collide with a permission's (R3).
const KIND_ELICITATION: &str = "acp_elicitation";

/// Parsed view of a renderable ACP `elicitation/create` (claude-agent-acp
/// `AskUserQuestion`, form mode). `None` when the request cannot be surfaced as
/// a single-choice interaction (url mode, arbitrary MCP schema, no enum) — the
/// caller replies `cancel` to avoid stalling the turn.
#[derive(Debug, Clone)]
struct AcpQuestion {
    field_name: String,
    prompt: String,
    options: Vec<InteractionOption>,
}

struct AcpElicitation {
    questions: Vec<AcpQuestion>,
}

/// Parse a form-mode `elicitation/create` into a single-choice interaction.
///
/// claude-agent-acp (`elicitation.ts`) renders each `AskUserQuestion` question
/// as `requestedSchema.properties.question_<n>` — single-select `{type:"string",
/// oneOf:[{const:LABEL,title:"LABEL — desc"}]}` (or multi-select `items.anyOf`)
/// — followed by a `question_<n>_custom` free-text field. The enum `const` is
/// always the option **label** (what the tool records as the answer), so the
/// emitted `InteractionOption` sets `option_id == label == const`: the frontend
/// submits the label (`formatInteractionResponseValue` maps optionId→label) and
/// we write it back as `content[content_field]`, which the tool matches against
/// the enum const. Multi-question/multi-select elicitations are reduced to the
/// first question, single-select (the A/B/C decision v0.6.0 targets); the
/// single-value write-back is consistent with the PiRpc/codex runtimes.
fn parse_acp_elicitation(params: &serde_json::Value) -> Option<AcpElicitation> {
    let mode = params
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("form");
    if mode != "form" {
        return None; // url-mode elicitations have no form rendering
    }
    let properties = params
        .get("requestedSchema")
        .and_then(|s| s.get("properties"))
        .and_then(|p| p.as_object())?;

    // Collect ALL `question_<n>` fields sorted by index (skip `_custom`
    // companion fields). This handles both single-question and multi-question
    // AskUserQuestion calls.
    let mut question_fields: Vec<(&String, &serde_json::Value)> = properties
        .iter()
        .filter(|(k, _)| is_question_field(k))
        .collect();
    question_fields.sort_by_key(|(k, _)| {
        k.strip_prefix("question_")
            .and_then(|n| n.parse::<u32>().ok())
            .unwrap_or(u32::MAX)
    });

    if question_fields.is_empty() {
        return None;
    }

    let mut questions = Vec::new();
    for (content_field, field) in &question_fields {
        let prompt = if question_fields.len() == 1 {
            params
                .get("message")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    extract_actual_question(field)
                        .map(|s| s.to_string())
                        .unwrap_or_default()
                })
        } else {
            extract_actual_question(field)
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    params
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                })
        };
        let options = extract_enum_options(field).unwrap_or_default();
        questions.push(AcpQuestion {
            field_name: (*content_field).clone(),
            prompt,
            options,
        });
    }

    Some(AcpElicitation { questions })
}

fn extract_actual_question(field: &serde_json::Value) -> Option<&str> {
    let desc = field.get("description").and_then(|v| v.as_str());
    let title = field.get("title").and_then(|v| v.as_str());
    match (desc, title) {
        (Some(d), Some(t)) => {
            if is_generic_question_title(t) {
                Some(d)
            } else if is_generic_question_title(d) {
                Some(t)
            } else {
                Some(d)
            }
        }
        (Some(d), None) => Some(d),
        (None, Some(t)) => Some(t),
        (None, None) => None,
    }
}

fn is_generic_question_title(s: &str) -> bool {
    let s_trimmed = s.trim();
    if s_trimmed.starts_with("问题") {
        let suffix = s_trimmed.strip_prefix("问题").unwrap().trim();
        return suffix.chars().all(|c| c.is_ascii_digit());
    }
    let lower = s_trimmed.to_ascii_lowercase();
    if lower.starts_with("question") {
        let suffix = lower.strip_prefix("question").unwrap().trim();
        return suffix.chars().all(|c| c.is_ascii_digit());
    }
    false
}

/// A `question_<n>` form field (not the `question_<n>_custom` companion).
fn is_question_field(key: &str) -> bool {
    let rest = match key.strip_prefix("question_") {
        Some(r) => r,
        None => return false,
    };
    !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit())
}

/// Extract choice options from a single-select `oneOf` or multi-select
/// `items.anyOf` enum. Each option's `const` is the answer label.
fn extract_enum_options(field: &serde_json::Value) -> Option<Vec<InteractionOption>> {
    let enum_list = field.get("oneOf").and_then(|v| v.as_array()).or_else(|| {
        field
            .get("items")
            .and_then(|i| i.get("anyOf"))
            .and_then(|v| v.as_array())
    })?;

    let options = enum_list
        .iter()
        .filter_map(|opt| {
            // `const` is the clean option label (the tool records it as the answer).
            let const_val = opt.get("const")?.as_str()?;
            // Prefer the structured description carried under ACP's `_meta`
            // extension; fall back to the "label — description" flattened title.
            let description = opt
                .get("_meta")
                .and_then(|m| m.get("_claude/askUserQuestionOption"))
                .and_then(|m| m.get("description"))
                .and_then(|v| v.as_str())
                .map(String::from)
                .or_else(|| {
                    opt.get("title")
                        .and_then(|v| v.as_str())
                        .and_then(|t| t.split_once(" — ").map(|(_, d)| d.to_string()))
                });
            Some(InteractionOption {
                option_id: const_val.to_string(),
                label: const_val.to_string(),
                description,
            })
        })
        .collect();
    Some(options)
}

fn permission_request_key(id: &serde_json::Value) -> String {
    id.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| id.to_string())
}

pub(crate) fn permission_option_id(params: &serde_json::Value, approved: bool) -> Option<String> {
    let options = params.get("options")?.as_array()?;
    options.iter().find_map(|option| {
        let option_id = option.get("optionId").and_then(|value| value.as_str())?;
        let kind = option
            .get("kind")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let option_id_lower = option_id.to_ascii_lowercase();
        let matches = if approved {
            kind.contains("allow")
                || kind.contains("approve")
                || option_id_lower.contains("allow")
                || option_id_lower.contains("approve")
        } else {
            kind.contains("reject")
                || kind.contains("deny")
                || option_id_lower.contains("reject")
                || option_id_lower.contains("deny")
        };
        matches.then(|| option_id.to_string())
    })
}

pub(crate) async fn write_permission_response(
    stdin: &mut (impl tokio::io::AsyncWrite + Unpin),
    id: &serde_json::Value,
    option_id: &str,
) -> Result<(), String> {
    let message = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "outcome": {
                "outcome": "selected",
                "optionId": option_id
            }
        }
    });
    stdin
        .write_all(format!("{message}\n").as_bytes())
        .await
        .map_err(|error| format!("ACP permission response write error: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("ACP permission response flush error: {error}"))
}

async fn reject_pending_permissions(
    writer: &AcpWriter,
    pending_permissions: &mut HashMap<String, PendingPermission>,
) {
    for (_, pending) in pending_permissions.drain() {
        let Some(option_id) = pending.reject_option_id else {
            log::warn!(
                "ACP permission request {:?} has no reject option; closing without approval",
                pending.rpc_id
            );
            continue;
        };
        if let Err(error) = writer
            .respond(
                &pending.rpc_id,
                json!({
                    "outcome": {
                        "outcome": "selected",
                        "optionId": option_id
                    }
                }),
            )
            .await
        {
            log::warn!("ACP failed to reject pending permission: {error}");
        }
    }
}

/// Drain pending elicitation/create requests on shutdown/cancel, replying
/// `cancel` so the agent does not block waiting for an answer that will never
/// arrive (design §5.2.1 three-state protocol).
async fn cancel_pending_elicitations(
    writer: &AcpWriter,
    pending_elicitations: &mut HashMap<String, PendingElicitation>,
) {
    for (_, pending) in pending_elicitations.drain() {
        if let Err(error) = writer
            .respond(
                &pending.rpc_id,
                elicit_result_payload(ElicitAction::Cancel, serde_json::Value::Null),
            )
            .await
        {
            log::warn!("ACP failed to cancel pending elicitation: {error}");
        }
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Spawn the ACP driver: establishes a persistent connection and returns an
/// `AcpControl` for sending prompts, cancels, and shutdowns.
pub fn spawn_acp_session(
    app: tauri::AppHandle,
    agent_id: String,
    pending_session_id: String,
    mut child: tokio::process::Child,
    project_path: String,
    requested_session_id: Option<String>,
    first_message: String,
    on_finish: impl FnOnce() + Send + 'static,
    on_session_resolved: impl Fn(&str) + Send + Sync + 'static,
) -> AcpControl {
    let stdin = child.stdin.take().expect("ACP process must have stdin");
    let stdout = child.stdout.take().expect("ACP process must have stdout");
    let stderr = child.stderr.take();

    let stdin_arc = Arc::new(TokioMutex::new(stdin));
    let acp_session_id = Arc::new(std::sync::Mutex::new(None::<String>));
    let stderr_buf = Arc::new(TokioMutex::new(String::new()));

    if let Some(stderr_stream) = stderr {
        let stderr_buf_clone = stderr_buf.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr_stream).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                log::warn!("[acp stderr] {}", line);
                let mut buf = stderr_buf_clone.lock().await;
                buf.push_str(&line);
                buf.push('\n');
            }
        });
    }

    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel(8);

    // stdout reader + event sink are constructed here so the connection loop can
    // run against a synthetic line stream / channel sink (tests, orchestrator).
    let (stdout_tx, stdout_rx) = tokio::sync::mpsc::channel(64);
    tokio::spawn(stdout_reader(stdout, stdout_tx));
    let emit = tauri_event_emitter(app.clone(), agent_id.clone());

    let control = AcpControl {
        tx: cmd_tx,
        acp_session_id: acp_session_id.clone(),
    };
    let control_clone = control.clone();

    tauri::async_runtime::spawn(async move {
        let result = acp_connection_loop(
            emit,
            pending_session_id.clone(),
            stdin_arc,
            acp_session_id,
            stdout_rx,
            project_path,
            requested_session_id,
            stderr_buf,
            cmd_rx,
            first_message,
            &on_session_resolved,
        )
        .await;
        // stdin_arc is dropped here along with AcpWriter inside the loop.

        if let Err(err) = &result {
            log::warn!("ACP connection loop exited with error: {}", err);
            let events = vec![
                NormalizedEvent::Error {
                    message: err.clone(),
                    recoverable: false,
                },
                NormalizedEvent::TurnComplete {
                    reason: TurnEndReason::Error,
                    usage: None,
                },
            ];
            emit_events(&app, &agent_id, &pending_session_id, &events);
        } else {
            log::info!(
                "ACP connection loop exited normally for session {}",
                pending_session_id
            );
        }

        // Ensure child exits: stdin is already closed (AcpWriter dropped).
        // Wait up to 5s, then force-kill.
        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(status)) => log::info!("ACP child exited with status: {}", status),
            Ok(Err(e)) => log::warn!("ACP child wait error: {}", e),
            Err(_) => {
                log::warn!("ACP child did not exit in 5s, force-killing");
                let pid = child.id().unwrap_or(0);
                let _ = crate::process_control::terminate_process_tree(pid);
            }
        }

        on_finish();
    });

    control_clone
}

// ---------------------------------------------------------------------------
// Internal: persistent connection loop
// ---------------------------------------------------------------------------

async fn acp_connection_loop(
    emit: AcpEventEmit,
    pending_session_id: String,
    stdin_arc: Arc<TokioMutex<ChildStdin>>,
    acp_session_id: Arc<std::sync::Mutex<Option<String>>>,
    mut stdout_rx: tokio::sync::mpsc::Receiver<String>,
    project_path: String,
    requested_session_id: Option<String>,
    stderr_buf: Arc<TokioMutex<String>>,
    mut command_rx: tokio::sync::mpsc::Receiver<AcpCommand>,
    first_message: String,
    on_session_resolved: &(dyn Fn(&str) + Send + Sync),
) -> Result<(), String> {
    let mut writer = AcpWriter::new(stdin_arc);

    // stdout reader is spawned by the caller (spawn_acp_session) so the loop can
    // be driven with a synthetic line stream in tests / by the orchestrator.

    // 2. Handshake: initialize → session/new
    let init_id = writer
        .request("initialize", acp_initialize_params())
        .await?;
    wait_for_response(&mut stdout_rx, init_id).await?;

    let session_result = if let Some(session_id) = requested_session_id.as_deref() {
        let resume_id = writer
            .request(
                "session/resume",
                json!({
                    "sessionId": session_id,
                    "cwd": project_path,
                    "mcpServers": []
                }),
            )
            .await?;
        wait_for_response(&mut stdout_rx, resume_id).await?
    } else {
        let new_id = writer
            .request(
                "session/new",
                json!({
                    "cwd": project_path,
                    "mcpServers": []
                }),
            )
            .await?;
        wait_for_response(&mut stdout_rx, new_id).await?
    };
    // session/new returns { sessionId, configOptions }; session/resume returns
    // only { configOptions } — opencode does not echo the sessionId back on
    // resume (the client already supplied it). Reuse the requested id for
    // resume; only session/new needs the server-minted id from the response.
    let session_id = match requested_session_id.as_deref() {
        Some(req_id) => req_id.to_string(),
        None => session_result
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "ACP session creation did not return sessionId".to_string())?
            .to_string(),
    };

    log::info!(
        "ACP session established: {} (pending: {})",
        session_id,
        pending_session_id
    );

    // Store session id
    {
        let mut guard = acp_session_id.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(session_id.clone());
    }

    // Emit SessionResolved
    emit(
        &[NormalizedEvent::SessionResolved {
            session_id: session_id.clone(),
        }],
        &pending_session_id,
    );
    on_session_resolved(&session_id);

    // 3. Send first message
    let prompt_id = writer
        .request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": first_message }]
            }),
        )
        .await?;
    log::debug!("ACP sent first prompt, id={}", prompt_id);

    // 4. Main loop
    let mut state = LoopState::Prompting { prompt_id };
    let mut usage: Option<UsageStats> = None;
    let mut buf: Vec<NormalizedEvent> = Vec::with_capacity(32);
    let mut last_flush = std::time::Instant::now();
    let mut pending_permissions: HashMap<String, PendingPermission> = HashMap::new();
    // Pending ACP elicitation/create (claude_code business questions). Kept in a
    // separate table from pending_permissions (R3 分表); Phase 3 populates it
    // when handling incoming elicitation/create.
    let mut pending_elicitations: HashMap<String, PendingElicitation> = HashMap::new();
    // Track whether the current prompt turn received any visible content
    // (text, thinking, tool calls). Some ACP servers (e.g. opencode) silently
    // return end_turn with zero content when the underlying model API fails.
    // Detecting this lets us surface a meaningful error instead of a blank turn.
    let mut turn_had_content = false;
    // Track call IDs of elicitation-only tools (AskUserQuestion) whose
    // tool_call_start was suppressed, so the matching tool_call_update
    // (result) can also be suppressed even when the tool name is missing
    // from the update event.
    let mut suppressed_acp_calls: std::collections::HashSet<String> = std::collections::HashSet::new();

    loop {
        let cmd_future = command_rx.recv();
        let idle_deadline = tokio::time::Instant::now() + IDLE_TIMEOUT;

        let exit = tokio::select! {
            // Command branch
            cmd = cmd_future => {
                match cmd {
                    Some(AcpCommand::Prompt(msg)) => {
                        log::info!("ACP loop received Prompt command, current state={}", match &state {
                            LoopState::Idle => "Idle",
                            LoopState::Prompting { .. } => "Prompting",
                            LoopState::CancelPending { .. } => "CancelPending",
                        });
                        match &mut state {
                            LoopState::Idle => {
                                usage = None;
                                turn_had_content = false;
                                let id = writer.request("session/prompt", json!({
                                    "sessionId": session_id,
                                    "prompt": [{ "type": "text", "text": msg }]
                                })).await?;
                                log::info!("ACP sent prompt to pi, id={}", id);
                                state = LoopState::Prompting { prompt_id: id };
                            }
                            LoopState::Prompting { .. } => {
                                log::warn!("ACP prompt ignored: still in Prompting state");
                            }
                            LoopState::CancelPending { pending_prompt, .. } => {
                                if pending_prompt.is_some() {
                                    log::warn!("ACP pending prompt overwritten in CancelPending");
                                }
                                log::info!("ACP prompt buffered: waiting for cancel response");
                                *pending_prompt = Some(msg);
                            }
                        }
                        false
                    }
                    Some(AcpCommand::Cancel) => {
                        reject_pending_permissions(&writer, &mut pending_permissions).await;
                        cancel_pending_elicitations(&writer, &mut pending_elicitations).await;
                        match &state {
                            LoopState::Prompting { prompt_id } => {
                                // Ask the agent to cancel the in-flight prompt.
                                // Some ACP servers (notably opencode) do not
                                // implement session/cancel and reject it with an
                                // error; the stdout loop detects that rejection
                                // and force-terminates the session so output
                                // actually stops. The next message then resumes
                                // the persisted session.
                                let cancel_id = writer
                                    .request(
                                        "session/cancel",
                                        json!({ "sessionId": session_id }),
                                    )
                                    .await
                                    .ok();
                                log::info!(
                                    "ACP cancel sent for prompt_id={} cancel_request_id={:?}",
                                    prompt_id,
                                    cancel_id
                                );
                                state = LoopState::CancelPending {
                                    old_prompt_id: *prompt_id,
                                    cancel_request_id: cancel_id,
                                    pending_prompt: None,
                                };
                            }
                            LoopState::Idle | LoopState::CancelPending { .. } => {}
                        }
                        false
                    }
                    Some(AcpCommand::Steer(_)) => {
                        // ACP does not have a native steer command; ignored.
                        log::debug!("ACP Steer ignored (ACP transport)");
                        false
                    }
                    Some(AcpCommand::RespondToInput {
                        id,
                        value,
                        response,
                    }) => {
                        // R7: route the business-interaction answer by pending
                        // table. Consults ONLY pending_elicitations (claude_code,
                        // populated in Phase 3) — never pending_permissions (R3
                        // 分表). ACP agents without an elicitation channel
                        // (opencode) have no mid-turn business path: report
                        // NoChannel so the frontend delivers the answer as a
                        // follow-up message instead.
                        let result = match route_acp_interaction_response(
                            &mut pending_elicitations,
                            &id,
                            &value,
                        ) {
                            AcpInteractionRoute::PendingNext { base_id, next_index } => {
                                if let Some(pending) = pending_elicitations.get(&base_id) {
                                    if let Some(next_q) = pending.questions.get(next_index) {
                                        let next_request_id = format!("{}_{}", base_id, next_index);
                                        buf.push(NormalizedEvent::InteractionRequest {
                                            request_id: next_request_id,
                                            prompt: next_q.prompt.clone(),
                                            options: next_q.options.clone(),
                                            allow_multiple: false,
                                            allow_custom_text: true,
                                            required: true,
                                            transport: InteractionTransport::AcpPreferred,
                                            origin: InteractionOrigin::AcpElicitation,
                                            delivery_hint: InteractionDeliveryHint::MidTurn,
                                            correlation: Some(InteractionCorrelation {
                                                session_id: Some(session_id.clone()),
                                                jsonrpc_id: Some(pending.rpc_id.clone()),
                                                request_kind: Some(KIND_ELICITATION.to_string()),
                                                ..Default::default()
                                            }),
                                        });
                                        flush_buf(&emit, &session_id, &mut buf);
                                        last_flush = std::time::Instant::now();
                                    }
                                }
                                Ok(())
                            }
                            AcpInteractionRoute::Elicit {
                                rpc_id,
                                action,
                                content,
                            } => {
                                let base_id = parse_sub_request_id(&id)
                                    .map(|(bid, _)| bid.to_string())
                                    .unwrap_or_else(|| id.clone());
                                pending_elicitations.remove(&base_id);
                                let payload = elicit_result_payload(action, content);
                                writer.respond(&rpc_id, payload).await
                            }
                            AcpInteractionRoute::NoChannel => {
                                log::warn!(
                                    "ACP RespondToInput for {id} has no pending elicitation; \
                                     this ACP agent has no mid-turn business channel"
                                );
                                Err(format!(
                                     "No pending ACP elicitation for interaction {id}; \
                                      this transport cannot answer mid-turn as a business question"
                                ))
                            }
                        };
                        let _ = response.send(result);
                        false
                    }
                    Some(AcpCommand::ResolvePermission {
                        request_id,
                        approved,
                        response,
                    }) => {
                        let result = if let Some(pending) = pending_permissions.remove(&request_id) {
                            let option_id = if approved {
                                pending.allow_option_id
                            } else {
                                pending.reject_option_id
                            };
                            if let Some(option_id) = option_id {
                                writer.respond(
                                    &pending.rpc_id,
                                    json!({
                                        "outcome": {
                                            "outcome": "selected",
                                            "optionId": option_id
                                        }
                                    }),
                                ).await
                            } else {
                                Err(format!(
                                    "ACP permission request {request_id} does not expose a {} option",
                                    if approved { "safe approval" } else { "rejection" }
                                ))
                            }
                        } else {
                            Err(format!("ACP permission request {request_id} is no longer pending"))
                        };
                        let _ = response.send(result);
                        false
                    }
                    Some(AcpCommand::Shutdown) => {
                        reject_pending_permissions(&writer, &mut pending_permissions).await;
                        cancel_pending_elicitations(&writer, &mut pending_elicitations).await;
                        log::info!("ACP shutdown requested for session {}", session_id);
                        true
                    }
                    None => {
                        log::info!("ACP command channel closed for session {}", session_id);
                        true
                    }
                }
            }
            // Stdout branch
            line = stdout_rx.recv() => {
                match line {
                    Some(line) => {
                        if line.trim().is_empty() { continue; }
                        let msg: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };

                        // Check if this matches the current prompt response
                        let current_prompt_id = match &state {
                            LoopState::Prompting { prompt_id } => Some(*prompt_id),
                            LoopState::CancelPending { old_prompt_id, .. } => Some(*old_prompt_id),
                            LoopState::Idle => None,
                        };

                        let mut force_exit = false;

                        if let Some(pid) = current_prompt_id {
                            // Only treat this message as a prompt response if
                            // it is actually a JSON-RPC *response* (has `result`
                            // or `error`, no `method`). Server-initiated REQUESTs
                            // like `elicitation/create` also carry an `id` field,
                            // and the server's id space is independent from ours —
                            // so a collision would misroute the elicitation as a
                            // prompt response, emit a spurious TurnComplete, and
                            // stall the agent waiting for an answer that never
                            // arrives (see issue: third AskUserQuestion hang).
                            let is_jsonrpc_response = msg.get("method").is_none()
                                && (msg.get("result").is_some() || msg.get("error").is_some());

                            if msg.get("id").and_then(|v| v.as_i64()) == Some(pid)
                                && is_jsonrpc_response
                            {
                                log::info!("ACP got prompt response for id={}, state={}", pid, match &state {
                                    LoopState::Idle => "Idle",
                                    LoopState::Prompting { .. } => "Prompting",
                                    LoopState::CancelPending { .. } => "CancelPending",
                                });
                                // Suppress cancel response events when a pending prompt exists
                                // to prevent the TurnComplete from killing the new message's
                                // streamStore state in the frontend.
                                let has_pending = matches!(
                                    &state,
                                    LoopState::CancelPending { pending_prompt: Some(_), .. }
                                );
                                if !has_pending {
                                    // Detect silent empty turns: the ACP server
                                    // returned end_turn but sent no content events
                                    // (text / thinking / tool calls). Surface an
                                    // error so the user doesn't see a blank screen.
                                    let stop_reason = msg.get("result")
                                        .and_then(|r| r.get("stopReason"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("end_turn");
                                    if !turn_had_content
                                        && stop_reason != "cancelled"
                                        && msg.get("error").is_none()
                                    {
                                        log::warn!(
                                            "ACP prompt id={} completed with stopReason={:?} but zero content events",
                                            pid, stop_reason
                                        );
                                        buf.push(NormalizedEvent::Error {
                                            message: "智能体本轮未返回任何内容，可能是上游异常。请重试或查看日志。".to_string(),
                                            recoverable: true,
                                        });
                                    }
                                    handle_prompt_response(&msg, &mut usage, &mut buf);
                                    flush_buf(&emit, &session_id, &mut buf);
                                }

                                // State transition
                                state = if let LoopState::CancelPending { pending_prompt, .. } = &mut state {
                                    let buffered = pending_prompt.take();
                                    if let Some(msg) = buffered {
                                        usage = None;
                                        turn_had_content = false;
                                        let new_id = writer.request("session/prompt", json!({
                                            "sessionId": session_id,
                                            "prompt": [{ "type": "text", "text": msg }]
                                        })).await?;
                                        log::info!("ACP sent buffered prompt after cancel, id={}", new_id);
                                        LoopState::Prompting { prompt_id: new_id }
                                    } else {
                                        log::info!("ACP state -> Idle after prompt response");
                                        LoopState::Idle
                                    }
                                } else {
                                    log::info!("ACP state -> Idle after prompt response");
                                    LoopState::Idle
                                };
                                continue;
                            }
                        }

                        // Detect the session/cancel response. Some ACP servers
                        // (notably opencode) do not implement session/cancel and
                        // reject it with an error; the agent then keeps streaming,
                        // so force-terminate the session — output stops, and the
                        // next message resumes the persisted session.
                        if let LoopState::CancelPending {
                            cancel_request_id: Some(cancel_id),
                            ..
                        } = &state
                        {
                            if msg.get("id").and_then(|v| v.as_i64()) == Some(*cancel_id) {
                                if msg.get("error").is_some() {
                                    log::warn!(
                                        "ACP session/cancel rejected by agent ({:?}); force-terminating session {}",
                                        msg.get("error"),
                                        session_id
                                    );
                                    buf.push(NormalizedEvent::TurnComplete {
                                        reason: TurnEndReason::Aborted,
                                        usage: usage.take(),
                                    });
                                    flush_buf(&emit, &session_id, &mut buf);
                                    force_exit = true;
                                } else if let LoopState::CancelPending {
                                    cancel_request_id,
                                    ..
                                } = &mut state
                                {
                                    *cancel_request_id = None;
                                }
                            }
                        }

                        // session/update notifications
                        if msg.get("method").and_then(|v| v.as_str()) == Some("session/update") {
                            if let Some(params) = msg.get("params") {
                                // Track suppressed tool_call IDs for elicitation-only tools.
                                // When tool_call_start produces no events (AskUserQuestion),
                                // record the call ID so we can suppress the result too.
                                if let Some(update) = params.get("update") {
                                    if let Some(update_type) = update.get("type").and_then(|v| v.as_str()) {
                                        if update_type == "tool_call" {
                                            if let Some(call_id) = update.get("toolCallId").and_then(|v| v.as_str()) {
                                                let tool = update.get("toolName")
                                                    .or_else(|| update.get("name"))
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or_default();
                                                if is_elicitation_only_tool(tool) {
                                                    suppressed_acp_calls.insert(call_id.to_string());
                                                }
                                            }
                                        }
                                    }
                                }

                                let events = normalize_acp_update(params, &mut usage);

                                // Also suppress tool_call_update (result) by call ID tracking,
                                // in case the tool name is missing from the update event.
                                let events: Vec<NormalizedEvent> = if let Some(update) = params.get("update") {
                                    let update_type = update.get("type").and_then(|v| v.as_str()).unwrap_or_default();
                                    if update_type == "tool_call_update" {
                                        if let Some(call_id) = update.get("toolCallId").and_then(|v| v.as_str()) {
                                            if suppressed_acp_calls.remove(call_id) {
                                                vec![] // Suppress by tracked ID
                                            } else {
                                                events
                                            }
                                        } else {
                                            events
                                        }
                                    } else {
                                        events
                                    }
                                } else {
                                    events
                                };

                                for event in &events {
                                    if is_content_event(event) {
                                        turn_had_content = true;
                                    }
                                    buf.push(event.clone());
                                }
                            }
                        } else if msg.get("method").and_then(|v| v.as_str()) == Some("session/request_permission") {
                            let Some(rpc_id) = msg.get("id").cloned() else {
                                log::warn!("ACP permission request ignored because it has no id");
                                continue;
                            };
                            let params = msg.get("params").cloned().unwrap_or_default();
                            let request_id = permission_request_key(&rpc_id);
                            pending_permissions.insert(
                                request_id.clone(),
                                PendingPermission {
                                    rpc_id,
                                    allow_option_id: permission_option_id(&params, true),
                                    reject_option_id: permission_option_id(&params, false),
                                },
                            );
                            buf.push(NormalizedEvent::ApprovalRequest {
                                request_id,
                                approval_kind: crate::agent::normalized::ApprovalKind::Other,
                                payload: params,
                            });
                            flush_buf(&emit, &session_id, &mut buf);
                            last_flush = std::time::Instant::now();
                        } else if msg.get("method").and_then(|v| v.as_str())
                            == Some("elicitation/create")
                        {
                            // claude-agent-acp business question (AskUserQuestion),
                            // capability-gated on the `elicitation.form` we advertised
                            // at initialize. A server REQUEST (carries `id`): we must
                            // eventually write back `{action, content}` or the turn
                            // stalls.
                            let Some(rpc_id) = msg.get("id").cloned() else {
                                log::warn!(
                                    "ACP elicitation/create ignored: no id (cannot reply)"
                                );
                                continue;
                            };
                            let params = msg.get("params").cloned().unwrap_or_default();
                            match parse_acp_elicitation(&params) {
                                Some(elic) => {
                                    // Register under the same key the frontend will
                                    // echo back as `request_id`, so RespondToInput's
                                    // route_acp_interaction_response lookup matches
                                    // (R3: kept in the DISTINCT elicitations table).
                                    let base_request_id = permission_request_key(&rpc_id);
                                    pending_elicitations.insert(
                                        base_request_id.clone(),
                                        PendingElicitation {
                                            rpc_id: rpc_id.clone(),
                                            questions: elic.questions.clone(),
                                            current_index: 0,
                                            answers: serde_json::Map::new(),
                                        },
                                    );
                                    if let Some(first_q) = elic.questions.first() {
                                        let request_id = format!("{}_0", base_request_id);
                                        buf.push(NormalizedEvent::InteractionRequest {
                                            request_id,
                                            prompt: first_q.prompt.clone(),
                                            options: first_q.options.clone(),
                                            allow_multiple: false,
                                            allow_custom_text: true,
                                            required: true,
                                            transport: InteractionTransport::AcpPreferred,
                                            origin: InteractionOrigin::AcpElicitation,
                                            delivery_hint: InteractionDeliveryHint::MidTurn,
                                            correlation: Some(InteractionCorrelation {
                                                session_id: Some(session_id.clone()),
                                                jsonrpc_id: Some(rpc_id),
                                                request_kind: Some(KIND_ELICITATION.to_string()),
                                                ..Default::default()
                                            }),
                                        });
                                    }
                                    flush_buf(&emit, &session_id, &mut buf);
                                    last_flush = std::time::Instant::now();
                                }
                                None => {
                                    // Unparsable elicitation (url mode, arbitrary MCP
                                    // schema, or no enum) — we have no UI to render it.
                                    // Reply `cancel` immediately so claude-agent-acp
                                    // does not block the turn awaiting an answer that
                                    // will never arrive (design §5.2.1 three-state).
                                    log::warn!(
                                        "ACP elicitation/create (id {:?}) is not a \
                                         renderable single-choice form; replying cancel",
                                        msg.get("id")
                                    );
                                    if let Err(error) = writer
                                        .respond(
                                            &rpc_id,
                                            elicit_result_payload(
                                                ElicitAction::Cancel,
                                                serde_json::Value::Null,
                                            ),
                                        )
                                        .await
                                    {
                                        log::warn!(
                                            "ACP failed to cancel unparsable elicitation: {error}"
                                        );
                                    }
                                }
                            }
                        } else {
                            log::debug!("ACP stdout ignored msg (no matching id, not session/update): method={:?}", msg.get("method"));
                        }

                        // Periodic flush
                        if buf.len() >= 32
                            || last_flush.elapsed() >= Duration::from_millis(8)
                        {
                            flush_buf(&emit, &session_id, &mut buf);
                            last_flush = std::time::Instant::now();
                        }
                        force_exit
                    }
                    None => {
                        log::warn!("ACP stdout EOF for session {}", session_id);
                        let stderr = stderr_buf.lock().await.clone();
                        if let Some(error) =
                            acp_unexpected_eof_error(&state, &session_id, &stderr)
                        {
                            return Err(error);
                        }
                        true
                    }
                }
            }
            // Idle timeout
            _ = tokio::time::sleep_until(idle_deadline) => {
                if matches!(state, LoopState::Idle) {
                    log::info!(
                        "ACP idle timeout ({}s), shutting down session {}",
                        IDLE_TIMEOUT.as_secs(),
                        session_id
                    );
                    true
                } else {
                    false
                }
            }
        };

        if exit {
            break;
        }
    }

    if !buf.is_empty() {
        flush_buf(&emit, &session_id, &mut buf);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Internal: stdout reader sub-task
// ---------------------------------------------------------------------------

async fn stdout_reader(stdout: tokio::process::ChildStdout, tx: tokio::sync::mpsc::Sender<String>) {
    let mut reader = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        if tx.send(line).await.is_err() {
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Internal: prompt response handler
// ---------------------------------------------------------------------------

fn handle_prompt_response(
    msg: &serde_json::Value,
    usage: &mut Option<UsageStats>,
    buf: &mut Vec<NormalizedEvent>,
) {
    if let Some(err) = msg.get("error") {
        let err_msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("ACP error");
        buf.push(NormalizedEvent::Error {
            message: err_msg.to_string(),
            recoverable: false,
        });
        buf.push(NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Error,
            usage: None,
        });
    } else {
        let stop_reason = msg
            .get("result")
            .and_then(|r| r.get("stopReason"))
            .and_then(|v| v.as_str())
            .unwrap_or("end_turn");

        if let Some(u) = msg.get("result").and_then(|r| r.get("usage")) {
            *usage = Some(UsageStats {
                input_tokens: u.get("inputTokens").and_then(|v| v.as_u64()),
                output_tokens: u.get("outputTokens").and_then(|v| v.as_u64()),
                total_cost: None,
                context_remaining: None,
            });
        }

        let reason = match stop_reason {
            "cancelled" => TurnEndReason::Aborted,
            "max_tokens" => TurnEndReason::MaxTokens,
            "refusal" | "error" => TurnEndReason::Error,
            _ => TurnEndReason::Complete,
        };
        buf.push(NormalizedEvent::TurnComplete {
            reason,
            usage: usage.take(),
        });
    }
}

// ---------------------------------------------------------------------------
// Internal: handshake response reader (channel-based with timeout)
// ---------------------------------------------------------------------------

async fn wait_for_response(
    stdout_rx: &mut tokio::sync::mpsc::Receiver<String>,
    expected_id: i64,
) -> Result<serde_json::Value, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut dummy_usage = None;
    loop {
        let line = tokio::select! {
            line = stdout_rx.recv() => {
                line.ok_or_else(|| "ACP process closed before response".to_string())?
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err("ACP handshake timeout (30s)".to_string());
            }
        };

        match handle_acp_response_line(&line, expected_id, &mut dummy_usage)? {
            AcpResponse::Result(val) => return Ok(val),
            AcpResponse::Error(err) => return Err(format!("ACP error: {}", err)),
            _ => continue, // Ignore updates or other messages during handshake
        }
    }
}

// ---------------------------------------------------------------------------
// Event helpers (unchanged from original)
// ---------------------------------------------------------------------------

/// Extract the text of an `agent_message_chunk` / `agent_thought_chunk` from a
/// `session/update` payload. Different ACP servers nest the text differently,
/// so accept the common shapes: `content.text`, a bare-string `content`, or a
/// top-level `text`. Returns "" when nothing parseable is found (the caller
/// drops empty chunks).
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
            } else {
                let interactions = interaction_requests_from_tool_call(&call_id, &tool, &input);
                if interactions.is_empty() {
                    // Elicitation-only tools (e.g. Claude Code's AskUserQuestion)
                    // have their UI rendered entirely by a separate channel
                    // (ACP `elicitation/create`). Suppress the ToolUseStart to
                    // avoid a phantom "Tool" card stuck in "running" state while
                    // the agent waits for the user's answer.
                    if is_elicitation_only_tool(&tool) {
                        vec![]
                    } else {
                        vec![NormalizedEvent::ToolUseStart {
                            call_id,
                            tool,
                            input,
                        }]
                    }
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
            });
            vec![]
        }
        _ => vec![],
    }
}

/// Returns `true` for normalised events that represent visible agent content
/// (text, thinking, tool calls). Used to detect silent empty turns where the
/// ACP server returns `end_turn` without streaming any content.
fn is_content_event(event: &NormalizedEvent) -> bool {
    matches!(
        event,
        NormalizedEvent::TextDelta { .. }
            | NormalizedEvent::Thinking { .. }
            | NormalizedEvent::ToolUseStart { .. }
            | NormalizedEvent::Message { .. }
    )
}

fn acp_unexpected_eof_error(state: &LoopState, session_id: &str, stderr: &str) -> Option<String> {
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

fn emit_events(
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

fn flush_buf(emit: &AcpEventEmit, session_id: &str, buf: &mut Vec<NormalizedEvent>) {
    if buf.is_empty() {
        return;
    }
    emit(buf, session_id);
    buf.clear();
}

// ---------------------------------------------------------------------------
// Tests (unchanged — only test normalize_acp_update)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
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
        let elic = parse_acp_elicitation(&params).expect("single-choice form is parseable");
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
        let elic = parse_acp_elicitation(&params).expect("multi-question form is parseable");
        assert_eq!(elic.questions.len(), 2);
        assert_eq!(elic.questions[0].prompt, "What deployment target?");
        assert_eq!(elic.questions[0].field_name, "question_1");
        assert_eq!(elic.questions[0].options.len(), 2);
        assert_eq!(elic.questions[0].options[0].option_id, "K8s");
        assert_eq!(elic.questions[1].prompt, "What scaling strategy?");
        assert_eq!(elic.questions[1].field_name, "question_2");
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
        let elic = parse_acp_elicitation(&params).expect("array/anyOf is parseable");
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
        assert!(parse_acp_elicitation(&params).is_none());
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
        assert!(parse_acp_elicitation(&params).is_none());
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
        let elic = parse_acp_elicitation(&params).unwrap();
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
        let response = json!({ "jsonrpc": "2.0", "id": prompt_id, "result": { "stopReason": "end_turn" } });
        let is_response = response.get("method").is_none()
            && (response.get("result").is_some() || response.get("error").is_some());
        assert!(is_response, "prompt response must be classified as response");

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
        let is_response = elicitation.get("method").is_none()
            && (elicitation.get("result").is_some() || elicitation.get("error").is_some());
        assert!(!is_response, "elicitation/create request must NOT be classified as response");

        // Verify the elicitation is still parseable even when its id collides.
        let params = elicitation.get("params").unwrap();
        let elic = parse_acp_elicitation(params).expect("elicitation should be parseable");
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
        let elic = parse_acp_elicitation(&params).unwrap();

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
}
