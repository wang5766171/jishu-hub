use super::*;

use super::elicitation::AcpQuestion;
use super::protocol::{write_jsonrpc_request, AcpWriter};

#[derive(Debug)]
pub(super) struct PendingPermission {
    pub(super) rpc_id: serde_json::Value,
    pub(super) allow_option_id: Option<String>,
    pub(super) reject_option_id: Option<String>,
}

/// A pending ACP `elicitation/create` (claude_code business question, capability-
/// gated). Stored in a DISTINCT table from `pending_permissions` (design R3 / §8.2:
/// `pending_permissions` 与 `pending_elicitations` 必须分表) so a business
/// interaction answer can never be mistaken for — or routed to — a tool approval.
#[derive(Debug, Clone)]
pub(super) struct PendingElicitation {
    pub(super) rpc_id: serde_json::Value,
    pub(super) questions: Vec<AcpQuestion>,
    pub(super) current_index: usize,
    pub(super) answers: serde_json::Map<String, serde_json::Value>,
}

/// Three-state ACP elicitation response action (protocol `accept`/`decline`/
/// `cancel`). jishu-hub's InteractionComposer only ever submits a chosen answer,
/// so the routed action is `Accept`; `Decline`/`Cancel` are modelled for protocol
/// completeness and future UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ElicitAction {
    Accept,
    Decline,
    Cancel,
}

/// Where a business-interaction answer should be written on ACP. Reads ONLY the
/// elicitations table — by construction business answers never consult the
/// permission table (R3 分表).
#[derive(Debug)]
pub(super) enum AcpInteractionRoute {
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

pub(super) fn parse_sub_request_id(request_id: &str) -> Option<(&str, usize)> {
    let last_underscore = request_id.rfind('_')?;
    let base_id = &request_id[..last_underscore];
    let index_str = &request_id[last_underscore + 1..];
    let sub_index = index_str.parse::<usize>().ok()?;
    Some((base_id, sub_index))
}

/// Route a business-interaction answer. Consults ONLY `pending_elicitations` —
/// a pending `request_permission` for the same request id is intentionally NOT
/// matched here (R3: business/permission 分表, never cross-consumed).
pub(super) fn route_acp_interaction_response(
    pending_elicitations: &mut HashMap<String, PendingElicitation>,
    request_id: &str,
    value: &str,
) -> AcpInteractionRoute {
    let Some((base_id, sub_index)) = parse_sub_request_id(request_id) else {
        return match pending_elicitations.get(request_id) {
            Some(pending) => {
                let mut content = serde_json::Map::new();
                if let Some(first_q) = pending.questions.first() {
                    let field_value = if first_q.is_multi_select {
                        serde_json::Value::Array(
                            value
                                .split('\n')
                                .filter(|s| !s.is_empty())
                                .map(|s| serde_json::Value::String(s.to_string()))
                                .collect(),
                        )
                    } else {
                        serde_json::Value::String(value.to_string())
                    };
                    content.insert(first_q.field_name.clone(), field_value);
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
        let field_value = if q.is_multi_select {
            serde_json::Value::Array(
                value
                    .split('\n')
                    .filter(|s| !s.is_empty())
                    .map(|s| serde_json::Value::String(s.to_string()))
                    .collect(),
            )
        } else {
            serde_json::Value::String(value.to_string())
        };
        pending.answers.insert(q.field_name.clone(), field_value);
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
pub(super) fn elicit_result_payload(
    action: ElicitAction,
    content: serde_json::Value,
) -> serde_json::Value {
    match action {
        ElicitAction::Accept => serde_json::json!({ "action": "accept", "content": content }),
        ElicitAction::Decline => serde_json::json!({ "action": "decline" }),
        ElicitAction::Cancel => serde_json::json!({ "action": "cancel" }),
    }
}

/// `InteractionCorrelation::request_kind` discriminator for ACP elicitations,
/// so a business-answer correlation can never collide with a permission's (R3).
pub(super) const KIND_ELICITATION: &str = "acp_elicitation";

pub(super) fn permission_request_key(id: &serde_json::Value) -> String {
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

pub(super) async fn reject_pending_permissions(
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
pub(super) async fn cancel_pending_elicitations(
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
