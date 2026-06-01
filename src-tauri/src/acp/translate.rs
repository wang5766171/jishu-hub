use crate::agent::NormalizedEvent;
use serde_json::Value;

/// Convert a NormalizedEvent to an ACP-compatible JSON value.
pub fn event_to_acp(event: &NormalizedEvent) -> Value {
    serde_json::to_value(event).unwrap_or_default()
}

/// Convert an ACP JSON value back to a NormalizedEvent.
pub fn acp_to_event(value: &Value) -> Option<NormalizedEvent> {
    serde_json::from_value(value.clone()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::normalized::TurnEndReason;

    #[test]
    fn roundtrip_text_delta() {
        let event = NormalizedEvent::TextDelta {
            delta: "hello".to_string(),
        };
        let acp = event_to_acp(&event);
        let back = acp_to_event(&acp);
        assert_eq!(Some(event), back);
    }

    #[test]
    fn roundtrip_turn_complete() {
        let event = NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Complete,
            usage: None,
        };
        let acp = event_to_acp(&event);
        let back = acp_to_event(&acp);
        assert_eq!(Some(event), back);
    }

    #[test]
    fn roundtrip_session_resolved() {
        let event = NormalizedEvent::SessionResolved {
            session_id: "acp_123".to_string(),
        };
        let acp = event_to_acp(&event);
        let back = acp_to_event(&acp);
        assert_eq!(Some(event), back);
    }

    #[test]
    fn roundtrip_error_event() {
        let event = NormalizedEvent::Error {
            message: "something went wrong".to_string(),
            recoverable: true,
        };
        let acp = event_to_acp(&event);
        let back = acp_to_event(&acp);
        assert_eq!(Some(event), back);
    }

    #[test]
    fn invalid_value_returns_none() {
        let v = serde_json::json!({"unknown": "field"});
        assert!(acp_to_event(&v).is_none());
    }
}
