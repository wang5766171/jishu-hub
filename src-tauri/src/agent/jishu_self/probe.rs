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

    let mut version = crate::agent::jishu_self::PI_AGENT_VERSION.to_string();

    let mut args = pi_cmd.base_args.clone();
    args.push("--version".to_string());

    let mut cmd = std::process::Command::new(&pi_cmd.program);
    cmd.args(&args);
    crate::process_command::std_no_window(&mut cmd);

    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let out_str = String::from_utf8_lossy(&output.stdout);
            let parsed = out_str.trim().to_string();
            if !parsed.is_empty() {
                // clap outputs "<name> <version>" (e.g. "jishu 0.79.1-3").
                // Extract just the version part.
                version = parsed
                    .rsplit_once(' ')
                    .map(|(_, v)| v.to_string())
                    .unwrap_or(parsed);
            }
        }
    }

    AgentHealth {
        installed: true,
        version: Some(version),
        error: None,
        binary_path: Some(pi_cmd.program.to_string_lossy().to_string()),
        last_checked_at: now_ms(),
    }
}

fn now_ms() -> i64 {
    crate::util::now_ms()
}
