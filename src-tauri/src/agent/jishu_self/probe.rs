use crate::agent::capability::AgentHealth;

pub fn probe_self() -> AgentHealth {
    let pi_cmd = match super::pi_runtime::resolve_pi_runtime() {
        Ok(cmd) => cmd,
        Err(err) => {
            return AgentHealth {
                installed: false,
                version: None,
                error: Some(err),
                binary_path: None,
                last_checked_at: now_ms(),
            }
        }
    };

    AgentHealth {
        installed: true,
        version: Some("Node.js (v0.78.1)".to_string()),
        error: None,
        binary_path: Some(pi_cmd.program.to_string_lossy().to_string()),
        last_checked_at: now_ms(),
    }
}

fn now_ms() -> i64 {
    crate::util::now_ms()
}
