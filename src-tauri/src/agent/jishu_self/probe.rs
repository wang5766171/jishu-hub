use crate::agent::capability::AgentHealth;

pub fn probe_self() -> AgentHealth {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(err) => {
            return AgentHealth {
                installed: false,
                version: None,
                error: Some(format!("Cannot determine current exe: {err}")),
                binary_path: None,
                last_checked_at: now_ms(),
            }
        }
    };

    // On Windows the binary is jishu.exe; on Unix it is just jishu.
    let parent = match exe.parent() {
        Some(p) => p,
        None => {
            return AgentHealth {
                installed: false,
                version: None,
                error: Some("No parent directory for current exe".to_string()),
                binary_path: None,
                last_checked_at: now_ms(),
            }
        }
    };

    #[cfg(target_os = "windows")]
    let binary_path = parent.join("jishu.exe");

    #[cfg(not(target_os = "windows"))]
    let binary_path = parent.join("jishu");

    let installed = binary_path.exists();

    AgentHealth {
        installed,
        version: if installed {
            Some(env!("CARGO_PKG_VERSION").to_string())
        } else {
            None
        },
        error: if installed {
            None
        } else {
            Some("jishu binary not found".to_string())
        },
        binary_path: if installed {
            Some(binary_path.to_string_lossy().to_string())
        } else {
            None
        },
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
