use chrono::{DateTime, Utc};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn pi_session_dir_for_home(home: &Path, project_path: &str) -> PathBuf {
    pi_sessions_root_for_home(home).join(pi_encode_cwd(Path::new(project_path)))
}

pub(crate) fn pi_sessions_root_for_home(home: &Path) -> PathBuf {
    home.join(".jishu-agent").join("sessions")
}

pub(crate) fn pi_sessions_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    Ok(pi_sessions_root_for_home(&home))
}

pub(crate) fn pi_session_dir(project_path: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    Ok(pi_session_dir_for_home(&home, project_path))
}

pub(crate) fn pi_encode_cwd(path: &Path) -> String {
    let value = path.display().to_string();
    let value = value.trim_start_matches(['/', '\\']);
    let value = value.replace(['/', '\\', ':'], "-");
    format!("--{value}--")
}

pub(crate) fn list_pi_sessions(encoded_name: &str) -> Result<Vec<crate::session::Session>, String> {
    let project_path = crate::project::decode_project_path(encoded_name);
    let session_dir = pi_session_dir(&project_path)?;
    if !session_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    for entry in fs::read_dir(&session_dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().map(|ext| ext == "jsonl").unwrap_or(false) {
            if let Some(mut session) = load_pi_session(&path) {
                session.last_active = file_modified_utc(&path);
                sessions.push(session);
            }
        }
    }

    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(sessions)
}

pub(crate) fn load_pi_session_messages(
    session_id: &str,
    encoded_name: &str,
) -> Result<Vec<crate::session::Message>, String> {
    // Note: `session_id` here is the id Pi stores inside the JSONL
    // (the value of `{"type":"session","id":"…"}`), NOT the
    // filename. Pi writes each session as
    // `<utc-timestamp>_<session-id>.jsonl`, and the GUI lists
    // sessions using the inner `session.id` (the short one), so we
    // have to scan the directory to find the file whose `session`
    // line matches the requested id.
    let project_path = crate::project::decode_project_path(encoded_name);
    let session_dir = pi_session_dir(&project_path)?;
    if !session_dir.is_dir() {
        return Err(format!("Pi session not found: {session_id}"));
    }
    for entry in fs::read_dir(&session_dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().map(|ext| ext == "jsonl").unwrap_or(false) {
            if let Some(session) = load_pi_session(&path) {
                if session.id == session_id {
                    return Ok(session.messages);
                }
            }
        }
    }
    Err(format!("Pi session not found: {session_id}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PiSessionLocation {
    pub(crate) session_id: String,
    pub(crate) session_dir: PathBuf,
    pub(crate) project_path: String,
    pub(crate) path: PathBuf,
}

pub(crate) fn find_pi_session_location(session_id: &str) -> Result<PiSessionLocation, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    find_pi_session_location_in_agent_dir(&home.join(".jishu-agent"), session_id)
}

pub(crate) fn find_pi_session_location_in_agent_dir(
    agent_dir: &Path,
    session_id: &str,
) -> Result<PiSessionLocation, String> {
    let sessions_root = agent_dir.join("sessions");
    if !sessions_root.is_dir() {
        return Err(format!("Pi session not found: {session_id}"));
    }

    for project_entry in fs::read_dir(&sessions_root).map_err(|e| e.to_string())? {
        let project_dir = project_entry.map_err(|e| e.to_string())?.path();
        if !project_dir.is_dir() {
            continue;
        }

        for entry in fs::read_dir(&project_dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if !path.extension().map(|ext| ext == "jsonl").unwrap_or(false) {
                continue;
            }

            if let Some(session) = load_pi_session(&path) {
                if session.id == session_id {
                    let project_path = session.project_path.unwrap_or_else(|| {
                        project_dir
                            .file_name()
                            .and_then(|name| name.to_str())
                            .map(crate::project::decode_project_path)
                            .unwrap_or_default()
                    });
                    return Ok(PiSessionLocation {
                        session_id: session.id,
                        session_dir: project_dir.clone(),
                        project_path,
                        path,
                    });
                }
            }
        }
    }

    Err(format!("Pi session not found: {session_id}"))
}

pub(crate) fn load_pi_session(path: &Path) -> Option<crate::session::Session> {
    let content = fs::read_to_string(path).ok()?;
    parse_pi_session_jsonl(path, &content)
}

fn parse_pi_session_jsonl(path: &Path, content: &str) -> Option<crate::session::Session> {
    let mut session_id = path.file_stem()?.to_string_lossy().to_string();
    let mut project_path = None;
    let mut started_at = None;
    let mut display_name = None;
    let mut messages = Vec::new();

    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        match value.get("type").and_then(|v| v.as_str()) {
            Some("session") => {
                if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
                    session_id = id.to_string();
                }
                project_path = value
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string());
                started_at = value
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(parse_rfc3339_utc);
            }
            // Pi's actual JSONL emits `message_start` (with the initial
            // message payload) and `message_end` (with the finalised
            // message) per message. Both carry the full message under
            // `value.message`, so we treat them the same way and
            // accept the legacy `message` type for older sessions.
            Some("message_start") | Some("message_end") | Some("message") => {
                let entry_timestamp = value
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(parse_rfc3339_millis);
                if let Some(message) = parse_pi_message(value.get("message")?, entry_timestamp) {
                    if display_name.is_none() && message.role == "user" {
                        display_name = first_text(&message).map(smart_summary);
                    }
                    messages.push(message);
                }
            }
            Some("session_info") => {
                display_name = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string);
            }
            _ => {}
        }
    }

    if messages.is_empty() {
        return None;
    }

    Some(crate::session::Session {
        id: session_id,
        path: path.to_path_buf(),
        messages,
        started_at,
        display_name,
        last_active: file_modified_utc(path),
        project_path,
    })
}

fn parse_pi_message(
    value: &serde_json::Value,
    entry_timestamp: Option<i64>,
) -> Option<crate::session::Message> {
    let role = value.get("role")?.as_str()?;
    let timestamp = value
        .get("timestamp")
        .and_then(|v| v.as_i64())
        .or(entry_timestamp);

    match role {
        "user" => Some(crate::session::Message {
            role: "user".to_string(),
            content: parse_user_content(value.get("content")?),
            timestamp,
        })
        .filter(|message| !message.content.is_empty()),
        "assistant" => Some(crate::session::Message {
            role: "assistant".to_string(),
            content: parse_assistant_content(value.get("content")?),
            timestamp,
        })
        .filter(|message| !message.content.is_empty()),
        "toolResult" => Some(crate::session::Message {
            role: "user".to_string(),
            content: vec![crate::session::ContentBlock::ToolResult {
                tool_use_id: value
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                content: pi_tool_result_content(value.get("content")),
            }],
            timestamp,
        }),
        _ => None,
    }
}

fn parse_user_content(value: &serde_json::Value) -> Vec<crate::session::ContentBlock> {
    match value {
        serde_json::Value::String(text) if !text.trim().is_empty() => {
            vec![crate::session::ContentBlock::Text { text: text.clone() }]
        }
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|item| match item.get("type").and_then(|v| v.as_str()) {
                Some("text") => item.get("text").and_then(|v| v.as_str()).map(|text| {
                    crate::session::ContentBlock::Text {
                        text: text.to_string(),
                    }
                }),
                Some("image") => Some(crate::session::ContentBlock::Text {
                    text: "[image omitted]".to_string(),
                }),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_assistant_content(value: &serde_json::Value) -> Vec<crate::session::ContentBlock> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item.get("type").and_then(|v| v.as_str()) {
                    Some("text") => item.get("text").and_then(|v| v.as_str()).map(|text| {
                        crate::session::ContentBlock::Text {
                            text: text.to_string(),
                        }
                    }),
                    Some("thinking") => {
                        item.get("thinking")
                            .and_then(|v| v.as_str())
                            .map(|thinking| crate::session::ContentBlock::Thinking {
                                thinking: thinking.to_string(),
                            })
                    }
                    Some("toolCall") => Some(crate::session::ContentBlock::ToolUse {
                        id: item
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        name: item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        input: item
                            .get("arguments")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    }),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn pi_tool_result_content(value: Option<&serde_json::Value>) -> serde_json::Value {
    match value {
        Some(serde_json::Value::Array(items)) => {
            let text = items
                .iter()
                .filter(|item| item.get("type").and_then(|v| v.as_str()) == Some("text"))
                .filter_map(|item| item.get("text").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join("\n");
            if text.is_empty() {
                serde_json::Value::Array(items.clone())
            } else {
                serde_json::Value::String(text)
            }
        }
        Some(value) => value.clone(),
        None => serde_json::Value::Null,
    }
}

fn first_text(message: &crate::session::Message) -> Option<String> {
    message.content.iter().find_map(|block| match block {
        crate::session::ContentBlock::Text { text } if !text.trim().is_empty() => {
            Some(text.clone())
        }
        _ => None,
    })
}

fn smart_summary(text: String) -> String {
    let text = text.trim();
    let first = text
        .split(&['。', '？', '！', '，', '\n', '.', '?', '!', ','][..])
        .next()
        .unwrap_or(text)
        .trim();
    if first.len() <= 50 {
        first.to_string()
    } else {
        let end = first
            .char_indices()
            .take_while(|(index, _)| *index < 50)
            .last()
            .map(|(index, ch)| index + ch.len_utf8())
            .unwrap_or(50);
        format!("{}…", &first[..end])
    }
}

fn parse_rfc3339_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn parse_rfc3339_millis(value: &str) -> Option<i64> {
    parse_rfc3339_utc(value).map(|dt| dt.timestamp_millis())
}

fn file_modified_utc(path: &Path) -> Option<DateTime<Utc>> {
    path.metadata()
        .ok()
        .and_then(|meta| meta.modified().ok())
        .map(DateTime::<Utc>::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::ContentBlock;
    use std::fs;

    #[test]
    fn builds_project_scoped_session_dir() {
        let dir = pi_session_dir_for_home(
            Path::new(r"C:\Users\tester"),
            r"D:\MyCodes\unified-auth-system",
        );

        assert_eq!(
            dir,
            PathBuf::from(
                r"C:\Users\tester\.jishu-agent\sessions\--D-MyCodes-unified-auth-system--"
            )
        );
    }

    #[test]
    fn parses_pi_session_header_and_messages() {
        let root =
            std::env::temp_dir().join(format!("jishu-pi-session-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("sid-1.jsonl");
        fs::write(
            &path,
            [
                r#"{"type":"session","version":3,"id":"sid-1","timestamp":"2026-06-01T00:00:00.000Z","cwd":"D:\\Work\\app"}"#,
                r#"{"type":"message_start","id":"u1","parentId":null,"timestamp":"2026-06-01T00:00:01.000Z","message":{"role":"user","content":"hello","timestamp":1780272001000}}"#,
                r#"{"type":"message_end","id":"a1","parentId":"u1","timestamp":"2026-06-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"done"},{"type":"toolCall","id":"call-1","name":"Read","arguments":{"file":"Cargo.toml"}}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1780272002000}}"#,
                r#"{"type":"message_end","id":"t1","parentId":"a1","timestamp":"2026-06-01T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"call-1","toolName":"Read","content":[{"type":"text","text":"file contents"}],"isError":false,"timestamp":1780272003000}}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let session = load_pi_session(&path).unwrap();

        assert_eq!(session.id, "sid-1");
        assert_eq!(session.project_path, Some(r"D:\Work\app".to_string()));
        assert_eq!(session.display_name, Some("hello".to_string()));
        assert_eq!(session.messages.len(), 3);
        assert_eq!(session.messages[0].role, "user");
        assert!(matches!(
            session.messages[0].content[0],
            ContentBlock::Text { .. }
        ));
        assert_eq!(session.messages[1].role, "assistant");
        assert!(matches!(
            session.messages[1].content[0],
            ContentBlock::Thinking { .. }
        ));
        assert!(matches!(
            session.messages[1].content[2],
            ContentBlock::ToolUse { .. }
        ));
        assert_eq!(session.messages[2].role, "user");
        assert!(matches!(
            session.messages[2].content[0],
            ContentBlock::ToolResult { .. }
        ));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn finds_pi_session_location_by_inner_session_id() {
        let root = std::env::temp_dir().join(format!(
            "jishu-pi-session-location-test-{}",
            std::process::id()
        ));
        let agent_dir = root.join(".jishu-agent");
        let project_path = r"D:\Work\app";
        let session_dir = agent_dir
            .join("sessions")
            .join(pi_encode_cwd(Path::new(project_path)));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&session_dir).unwrap();
        let path = session_dir.join("20260601_sid-real.jsonl");
        fs::write(
            &path,
            [
                r#"{"type":"session","version":3,"id":"sid-real","timestamp":"2026-06-01T00:00:00.000Z","cwd":"D:\\Work\\app"}"#,
                r#"{"type":"message_start","id":"u1","parentId":null,"timestamp":"2026-06-01T00:00:01.000Z","message":{"role":"user","content":"hello","timestamp":1780272001000}}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let location = find_pi_session_location_in_agent_dir(&agent_dir, "sid-real").unwrap();

        assert_eq!(location.session_id, "sid-real");
        assert_eq!(location.session_dir, session_dir);
        assert_eq!(location.project_path, project_path);
        assert_eq!(location.path, path);

        let _ = fs::remove_dir_all(&root);
    }

    /// Regression test against an actual JSONL that `pi --mode json`
    /// produced on a real run. Captures a snapshot at
    /// `tests/fixtures/pi_session_real.jsonl`; the test loads and
    /// parses it the same way the GUI would.
    #[test]
    fn parses_real_pi_session_jsonl_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("pi_session_real.jsonl");
        if !path.exists() {
            eprintln!("skipping: fixture {} not present", path.display());
            return;
        }
        let session = load_pi_session(&path).expect("real fixture should parse");
        assert!(!session.messages.is_empty(), "real fixture has messages");
        // First message is the user's "你是谁" prompt.
        assert_eq!(session.messages[0].role, "user");
        assert!(
            session
                .messages
                .iter()
                .any(|m| m.role == "assistant"
                    && m.content.iter().any(|b| matches!(b, crate::session::ContentBlock::Text { text } if text.contains("jishu")))),
            "real fixture must contain an assistant reply mentioning jishu",
        );
    }

    #[test]
    fn uses_pi_cwd_encoding_for_session_directories() {
        let home = Path::new(r"C:\Users\tester");
        let project_path = r"D:\My Codes\app";
        assert_eq!(
            pi_session_dir_for_home(home, project_path),
            home.join(".jishu-agent")
                .join("sessions")
                .join("--D-My Codes-app--")
        );
    }

    #[test]
    fn test_parse_real_file() {
        let path = std::path::Path::new("C:\\Users\\51743\\.jishu-agent\\sessions\\E--Claude-test\\2026-06-06T01-14-06-927Z_019e9a7e-92cf-7e5b-a24d-8d333432e821.jsonl");
        let session = crate::agent::jishu_self::pi_session::load_pi_session(path);
        println!("Session parsed: {}", session.is_some());
        if let Some(s) = session {
            println!("Messages count: {}", s.messages.len());
        }
    }
}
