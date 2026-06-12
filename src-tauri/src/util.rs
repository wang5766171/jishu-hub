use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Returns the current time in milliseconds since Unix epoch.
/// Shared utility to avoid duplicating this in every module.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Generate a string ID with a prefix
pub fn gen_id(prefix: &str) -> String {
    format!("{}_{}", prefix, uuid::Uuid::new_v4().simple())
}

/// Redact common credential forms before text enters durable logs or events.
pub fn redact_sensitive_text(input: &str) -> String {
    input
        .split_inclusive('\n')
        .map(redact_sensitive_line)
        .collect()
}

fn redact_sensitive_line(line: &str) -> String {
    let lowercase = line.to_ascii_lowercase();
    if let Some(bearer_start) = lowercase.find("bearer ") {
        let token_start = bearer_start + "bearer ".len();
        let token_end = line[token_start..]
            .find(char::is_whitespace)
            .map(|offset| token_start + offset)
            .unwrap_or(line.trim_end_matches(['\r', '\n']).len());
        let mut redacted = String::with_capacity(line.len());
        redacted.push_str(&line[..token_start]);
        redacted.push_str("[REDACTED]");
        redacted.push_str(&line[token_end..]);
        return redacted;
    }

    const SENSITIVE_KEYS: [&str; 8] = [
        "authorization",
        "api_key",
        "api-key",
        "apikey",
        "access_token",
        "password",
        "private_key",
        "client_secret",
    ];
    for key in SENSITIVE_KEYS {
        let Some(key_start) = lowercase.find(key) else {
            continue;
        };
        let value_separator = line[key_start + key.len()..]
            .find([':', '='])
            .map(|offset| key_start + key.len() + offset);
        let Some(separator) = value_separator else {
            continue;
        };
        let line_end = line.trim_end_matches(['\r', '\n']).len();
        let mut redacted = String::with_capacity(line.len());
        redacted.push_str(&line[..separator + 1]);
        redacted.push_str(" [REDACTED]");
        redacted.push_str(&line[line_end..]);
        return redacted;
    }

    line.to_string()
}

/// Atomically write content to a file by writing to a unique temp file
/// then renaming. Prevents corruption on crash/power-loss.
/// Uses PID + nanos for uniqueness to avoid concurrent-write collisions.
pub fn atomic_write(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let tmp = unique_tmp_path(path);
    std::fs::write(&tmp, content)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn unique_tmp_path(path: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(format!(".{}-{}.tmp", std::process::id(), nanos));
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::redact_sensitive_text;

    #[test]
    fn redacts_bearer_tokens_and_secret_values() {
        assert_eq!(
            redact_sensitive_text("Authorization: Bearer abc.def\npassword=hello\n"),
            "Authorization: Bearer [REDACTED]\npassword= [REDACTED]\n"
        );
    }

    #[test]
    fn preserves_non_secret_token_usage_fields() {
        let input = r#"{"input_tokens":10,"output_tokens":20}"#;
        assert_eq!(redact_sensitive_text(input), input);
    }
}
