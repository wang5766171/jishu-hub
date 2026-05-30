use std::path::PathBuf;

use crate::agent::capability::AgentHealth;

/// Cross-platform binary discovery
pub async fn probe_binary(name: &str, candidates: &[&str]) -> Option<PathBuf> {
    // 1. Try which/where on PATH
    #[cfg(target_os = "windows")]
    let lookup_result = {
        let mut command = tokio::process::Command::new("where");
        crate::process_command::tokio_no_window(command.arg(name))
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
    };

    #[cfg(not(target_os = "windows"))]
    let lookup_result = tokio::process::Command::new("which")
        .arg(name)
        .output()
        .await
        .ok()
        .filter(|o| o.status.success());

    if let Some(output) = lookup_result {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(first_line) = stdout.lines().next() {
            let path = PathBuf::from(first_line.trim());
            if path.exists() {
                return Some(path);
            }
        }
    }

    // 2. Explicit candidate paths
    for c in candidates {
        let expanded = expand_env_vars(c);
        let p = PathBuf::from(&expanded);
        if p.exists() {
            return Some(p);
        }
        #[cfg(target_os = "windows")]
        {
            let with_ext = p.with_extension("cmd");
            if with_ext.exists() {
                return Some(with_ext);
            }
        }
    }

    None
}

fn expand_env_vars(s: &str) -> String {
    let mut result = s.to_string();

    // Expand %VAR% on Windows
    #[cfg(target_os = "windows")]
    {
        while let Some(start) = result.find('%') {
            if let Some(end) = result[start + 1..].find('%') {
                let var_name = &result[start + 1..start + 1 + end];
                if let Ok(val) = std::env::var(var_name) {
                    result = format!(
                        "{}{}{}",
                        &result[..start],
                        val,
                        &result[start + 1 + end + 1..]
                    );
                } else {
                    break;
                }
            } else {
                break;
            }
        }
    }

    // Expand ~ to home directory
    if result.starts_with('~') {
        if let Some(home) = dirs::home_dir() {
            result = format!("{}{}", home.display(), &result[1..]);
        }
    }

    result
}

/// Get version string from a binary
pub async fn version_of(path: &PathBuf) -> Option<String> {
    let mut command = tokio::process::Command::new(path);
    let output = crate::process_command::tokio_no_window(command.arg("--version"))
        .output()
        .await
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_version(&stdout)
}

fn extract_version(s: &str) -> Option<String> {
    for word in s.split_whitespace() {
        let trimmed = word.trim_start_matches('v');
        let parts: Vec<&str> = trimmed.split('.').collect();
        if parts.len() >= 2 && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit())) {
            return Some(trimmed.to_string());
        }
    }
    None
}

pub fn build_health(
    binary: Option<PathBuf>,
    version: Option<String>,
    error: Option<String>,
) -> AgentHealth {
    AgentHealth {
        installed: binary.is_some(),
        version,
        error,
        binary_path: binary.map(|p| p.to_string_lossy().to_string()),
        last_checked_at: now_ms(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Default candidate paths for known agents
pub fn default_candidates_for(name: &str) -> Vec<String> {
    #[cfg(not(target_os = "windows"))]
    let home = dirs::home_dir().unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    let home_str = home.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let local_appdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let userprofile = std::env::var("USERPROFILE").unwrap_or_default();

        match name {
            "claude" => vec![
                format!("{}\\npm\\claude.cmd", appdata),
                format!("{}\\.bun\\bin\\claude", userprofile),
            ],
            "codex" => vec![
                format!("{}\\npm\\codex.cmd", appdata),
                format!("{}\\.bun\\bin\\codex", userprofile),
            ],
            "opencode" => vec![
                format!("{}\\npm\\opencode.cmd", appdata),
                format!("{}\\.bun\\bin\\opencode", userprofile),
                format!("{}\\Programs\\opencode\\opencode.exe", local_appdata),
            ],
            _ => vec![],
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        match name {
            "claude" => vec![
                format!("{}/.bun/bin/claude", home_str),
                "/usr/local/bin/claude".to_string(),
            ],
            "codex" => vec![
                format!("{}/.bun/bin/codex", home_str),
                "/usr/local/bin/codex".to_string(),
            ],
            "opencode" => vec![
                format!("{}/.bun/bin/opencode", home_str),
                "/usr/local/bin/opencode".to_string(),
            ],
            _ => vec![],
        }
    }
}
