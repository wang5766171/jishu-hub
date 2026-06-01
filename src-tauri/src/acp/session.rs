use crate::agent::normalized::TurnEndReason;
use crate::agent::NormalizedEvent;

/// Manages a single ACP server-side session.
pub struct AcpSession {
    cwd: String,
    model: Option<String>,
    session_id: Option<String>,
    active: bool,
}

impl AcpSession {
    pub fn new(cwd: String, model: Option<String>) -> Self {
        Self {
            cwd,
            model,
            session_id: None,
            active: false,
        }
    }

    /// Create a new session, returning the session ID.
    pub fn create(&mut self) -> String {
        let id = format!("acp_{}", std::process::id());
        self.session_id = Some(id.clone());
        self.active = true;
        id
    }

    /// Process a prompt message and return a list of normalized events.
    ///
    /// For v0.6.0 this is a stub that echoes the message back. Future versions
    /// will route through the orchestrator / agent system.
    pub fn prompt(&mut self, message: String) -> Vec<NormalizedEvent> {
        let mut events = Vec::new();

        // Emit session resolved if we have a session.
        if let Some(ref sid) = self.session_id {
            events.push(NormalizedEvent::SessionResolved {
                session_id: sid.clone(),
            });
        }

        // Stub: echo the message back. Real implementation will delegate to
        // the orchestrator via ChatRequest.
        let _ = &self.cwd;
        let _ = &self.model;
        events.push(NormalizedEvent::TextDelta {
            delta: format!("[ACP stub] Received: {message}"),
        });
        events.push(NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Complete,
            usage: None,
        });

        events
    }

    /// Cancel the current ongoing prompt processing.
    pub fn cancel(&mut self) {
        self.active = false;
    }

    /// Close the session and release resources.
    pub fn close(&mut self) {
        self.active = false;
        self.session_id = None;
    }

    /// Whether the session is currently active.
    #[allow(dead_code)]
    pub fn is_active(&self) -> bool {
        self.active
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_create_and_prompt() {
        let mut session = AcpSession::new(".".to_string(), None);
        let sid = session.create();
        assert!(sid.starts_with("acp_"));
        assert!(session.is_active());

        let events = session.prompt("hello".to_string());
        assert_eq!(events.len(), 3);
        assert!(matches!(events[0], NormalizedEvent::SessionResolved { .. }));
        assert!(matches!(events[1], NormalizedEvent::TextDelta { .. }));
        assert!(matches!(events[2], NormalizedEvent::TurnComplete { .. }));
    }

    #[test]
    fn session_cancel_and_close() {
        let mut session = AcpSession::new(".".to_string(), None);
        session.create();
        assert!(session.is_active());

        session.cancel();
        assert!(!session.is_active());

        session.close();
        assert!(!session.is_active());
    }
}
