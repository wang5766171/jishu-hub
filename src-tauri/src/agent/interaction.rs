//! Interaction-delivery abstraction for v0.6.0 interaction generalization.
//!
//! The same user-facing structured question (A/B/C options + custom text) is
//! surfaced over different transport/protocol channels, and *not every channel*
//! can answer mid-turn (true pause-resume). This module is the single source of
//! truth that decides, given a transport + origin, whether the answer can be
//! written back as a mid-turn injection or must fall back to a follow-up user
//! message.
//!
//! Two layers:
//! - `delivery_hint_for` → `InteractionDeliveryHint`: a forward-looking hint
//!   embedded in the emitted `NormalizedEvent::InteractionRequest` so the
//!   frontend *can* pre-stage an interleave split. It is advisory only.
//! - `delivery_for` → `InteractionDelivery`: the authoritative decision taken
//!   at answer time inside `respond_chat_interaction`, based on the transport's
//!   *actual* capability at that moment (design R6 — the frontend must never
//!   assume mid-turn from the event hint alone).
//!
//! The gating matrix mirrors the wire-format spike
//! (`.tmp/interaction-feasibility/spike.mjs`, §15) and the ground-truth memory
//! `protocol-interaction-ground-truth.md`:
//!
//! | transport        | origin                       | delivery |
//! |------------------|------------------------------|----------|
//! | PiRpc            | ExtensionUi                  | mid_turn |
//! | CodexAppServer   | CodexToolRequestUserInput    | mid_turn |
//! | AcpPreferred     | AcpElicitation               | mid_turn |
//! | (anything else)  | (anything else)              | follow_up|

use serde::{Deserialize, Serialize};

use super::normalized::{InteractionDeliveryHint, InteractionOrigin};
use super::TransportSurface;

/// The authoritative delivery outcome for an interaction answer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractionDelivery {
    /// The answer was injected into the still-running turn (true pause-resume).
    /// The frontend should interleave it into the current assistant stream at
    /// the request's insertion point.
    MidTurn,
    /// The answer could not be written back mid-turn and was instead sent as a
    /// new turn's user message. The frontend should render it as an ordinary
    /// follow-up message (no interleaving).
    FollowUp,
}

impl InteractionDelivery {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MidTurn => "mid_turn",
            Self::FollowUp => "follow_up",
        }
    }
}

impl From<InteractionDelivery> for InteractionDeliveryHint {
    fn from(delivery: InteractionDelivery) -> Self {
        match delivery {
            InteractionDelivery::MidTurn => InteractionDeliveryHint::MidTurn,
            InteractionDelivery::FollowUp => InteractionDeliveryHint::FollowUp,
        }
    }
}

/// DTO returned by the `respond_chat_interaction` command so the frontend can
/// decide whether to interleave the answer (mid_turn) or render it as a
/// follow-up message. This is the design's R6 contract surface.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractionResponseDto {
    pub delivery: String,
}

impl InteractionResponseDto {
    pub fn from_delivery(delivery: InteractionDelivery) -> Self {
        Self {
            delivery: delivery.as_str().to_string(),
        }
    }
}

/// Forward-looking hint embedded in the emitted interaction event. See module
/// docs — advisory only, never authoritative.
pub fn delivery_hint_for(
    transport: TransportSurface,
    origin: InteractionOrigin,
) -> InteractionDeliveryHint {
    match delivery_for(transport, origin) {
        InteractionDelivery::MidTurn => InteractionDeliveryHint::MidTurn,
        InteractionDelivery::FollowUp => InteractionDeliveryHint::FollowUp,
    }
}

/// Authoritative delivery decision for an interaction of `origin` on `transport`.
///
/// This encodes the protocol-verified reachability table (ground-truth memory +
/// spike §15). Callers in `respond_chat_intersection` pass the *actual* current
/// transport; if a runtime's capability probe fails at answer time, it should
/// return `FollowUp` regardless (the codex/ACP runtimes enforce their own
/// capability gates before reaching here).
pub fn delivery_for(transport: TransportSurface, origin: InteractionOrigin) -> InteractionDelivery {
    match (transport, origin) {
        // Production mid-turn baselines — verified mid-turn pause-resume.
        (TransportSurface::PiRpc, InteractionOrigin::ExtensionUi) => InteractionDelivery::MidTurn,
        (TransportSurface::CodexAppServer, InteractionOrigin::CodexToolRequestUserInput) => {
            InteractionDelivery::MidTurn
        }
        (TransportSurface::AcpPreferred, InteractionOrigin::AcpElicitation) => {
            InteractionDelivery::MidTurn
        }
        // Everything else (generic tool-call questions, codex/ACP approvals,
        // capability-absent downgrades, CLI) cannot be answered mid-turn as a
        // business question and falls back to a follow-up message.
        _ => InteractionDelivery::FollowUp,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_extension_ui_is_mid_turn() {
        assert_eq!(
            delivery_for(TransportSurface::PiRpc, InteractionOrigin::ExtensionUi),
            InteractionDelivery::MidTurn
        );
        assert_eq!(
            delivery_hint_for(TransportSurface::PiRpc, InteractionOrigin::ExtensionUi),
            InteractionDeliveryHint::MidTurn
        );
    }

    #[test]
    fn codex_business_question_is_mid_turn() {
        assert_eq!(
            delivery_for(
                TransportSurface::CodexAppServer,
                InteractionOrigin::CodexToolRequestUserInput
            ),
            InteractionDelivery::MidTurn
        );
    }

    #[test]
    fn claude_elicitation_is_mid_turn() {
        assert_eq!(
            delivery_for(
                TransportSurface::AcpPreferred,
                InteractionOrigin::AcpElicitation
            ),
            InteractionDelivery::MidTurn
        );
    }

    #[test]
    fn generic_and_approval_origins_fall_back() {
        // Generic text tool-call question on any transport → follow-up.
        assert_eq!(
            delivery_for(TransportSurface::PiRpc, InteractionOrigin::Text),
            InteractionDelivery::FollowUp
        );
        // codex MCP/command approvals are not business questions → follow-up.
        assert_eq!(
            delivery_for(
                TransportSurface::CodexAppServer,
                InteractionOrigin::CodexMcpApproval
            ),
            InteractionDelivery::FollowUp
        );
        assert_eq!(
            delivery_for(
                TransportSurface::CodexAppServer,
                InteractionOrigin::CodexApproval
            ),
            InteractionDelivery::FollowUp
        );
        // CLI transport always falls back.
        assert_eq!(
            delivery_for(TransportSurface::Cli, InteractionOrigin::ExtensionUi),
            InteractionDelivery::FollowUp
        );
    }

    #[test]
    fn dto_serializes_snake_case() {
        let mid = InteractionResponseDto::from_delivery(InteractionDelivery::MidTurn);
        assert_eq!(mid.delivery, "mid_turn");
        let follow = InteractionResponseDto::from_delivery(InteractionDelivery::FollowUp);
        assert_eq!(follow.delivery, "follow_up");

        let json = serde_json::to_string(&mid).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&json).unwrap()["delivery"],
            "mid_turn"
        );
    }
}
