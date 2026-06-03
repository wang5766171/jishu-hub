use crate::agent::normalized::NormalizedEvent;

/// Parse a single JSON-lines event from the jishu agent-bridge subprocess.
/// The agent-bridge protocol speaks NormalizedEvent directly, so this is a
/// straight serde deserialization pass.
pub fn normalize_line(line: &str) -> Option<NormalizedEvent> {
    serde_json::from_str::<NormalizedEvent>(line).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::normalized::TurnEndReason;

    #[test]
    fn parses_text_delta() {
        let event = normalize_line(r#"{"kind":"text_delta","delta":"hello"}"#);
        assert_eq!(
            event,
            Some(NormalizedEvent::TextDelta {
                delta: "hello".to_string()
            })
        );
    }

    #[test]
    fn returns_none_for_invalid_json() {
        assert!(normalize_line("not json").is_none());
    }

    #[test]
    fn parses_turn_complete() {
        let event = normalize_line(r#"{"kind":"turn_complete","reason":"Complete","usage":null}"#);
        assert_eq!(
            event,
            Some(NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                usage: None,
            })
        );
    }
}
