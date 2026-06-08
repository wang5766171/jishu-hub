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

    // Jishu Agent is the built-in agent of Jishu Hub. The version shown in
    // the GUI (env-check page, agent switcher) should be the Jishu Hub
    // package version, not the underlying pi runtime version. The pi runtime
    // is an internal implementation detail that the user should not see.
    AgentHealth {
        installed: true,
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        error: None,
        binary_path: Some(pi_cmd.program.to_string_lossy().to_string()),
        last_checked_at: now_ms(),
    }
}

fn now_ms() -> i64 {
    crate::util::now_ms()
}
