use crate::agent::capability::AgentHealth;

pub fn probe_self() -> AgentHealth {
    let binary_path = match super::resolve_jishu_cli_binary() {
        Ok(path) => path,
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
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        error: None,
        binary_path: Some(binary_path.to_string_lossy().to_string()),
        last_checked_at: now_ms(),
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
