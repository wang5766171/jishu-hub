use chrono::{DateTime, Local, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::agent::{
    normalized::{NormalizedEvent, TurnEndReason},
    AgentCapabilities, AgentHealth, AgentInfo, AgentPlugin, ChatRequest,
};

pub struct OpencodeAdapter;

impl OpencodeAdapter {
    pub fn new() -> Self {
        Self
    }
}

pub fn normalize_stream_event(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    match event_type(event) {
        Some("step_start") | Some("step-start") => normalize_opencode_session(event),
        Some("text") | Some("text_delta") | Some("message.delta") => {
            let delta = event
                .get("text")
                .or_else(|| event.get("delta"))
                .or_else(|| event.get("content"))
                .or_else(|| event.get("part").and_then(|part| part.get("text")))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if delta.is_empty() {
                raw(event)
            } else {
                vec![NormalizedEvent::TextDelta {
                    delta: delta.to_string(),
                }]
            }
        }
        Some("reasoning") => normalize_opencode_reasoning(event),
        Some("tool_use") => normalize_opencode_tool_use(event),
        Some("message") | Some("message.completed") => normalize_opencode_message(event),
        Some("step_finish") | Some("step-finish") => normalize_opencode_step_finish(event),
        Some("error") => normalize_opencode_error(event),
        Some("session.idle") | Some("result") => normalize_opencode_complete(event),
        _ => raw(event),
    }
}

fn event_type(event: &serde_json::Value) -> Option<&str> {
    event
        .get("type")
        .or_else(|| event.get("part").and_then(|part| part.get("type")))
        .and_then(|v| v.as_str())
}

fn normalize_opencode_session(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    if let Some(session_id) = opencode_session_id(event) {
        return vec![NormalizedEvent::SessionResolved {
            session_id: session_id.to_string(),
        }];
    }
    raw(event)
}

fn normalize_opencode_message(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    if let Some(text) = event
        .get("text")
        .or_else(|| event.get("content"))
        .or_else(|| event.get("part").and_then(|part| part.get("text")))
        .and_then(|v| v.as_str())
    {
        return vec![NormalizedEvent::TextDelta {
            delta: text.to_string(),
        }];
    }
    raw(event)
}

fn normalize_opencode_reasoning(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    if let Some(thinking) = event
        .get("text")
        .or_else(|| event.get("content"))
        .or_else(|| event.get("part").and_then(|part| part.get("text")))
        .and_then(|v| v.as_str())
    {
        return vec![NormalizedEvent::Thinking {
            delta: thinking.to_string(),
        }];
    }
    raw(event)
}

fn normalize_opencode_tool_use(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    let part = event.get("part").unwrap_or(event);
    let state = part.get("state").unwrap_or(part);
    let call_id = part
        .get("callID")
        .or_else(|| part.get("call_id"))
        .or_else(|| event.get("callID"))
        .or_else(|| event.get("call_id"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let tool = part
        .get("tool")
        .or_else(|| event.get("tool"))
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let input = state
        .get("input")
        .or_else(|| part.get("input"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    if call_id.is_empty() {
        return raw(event);
    }

    let mut normalized = vec![NormalizedEvent::ToolUseStart {
        call_id: call_id.clone(),
        tool,
        input,
    }];

    if let Some(output) = state.get("output").or_else(|| part.get("output")).cloned() {
        let is_error = state
            .get("status")
            .and_then(|v| v.as_str())
            .map(|status| status.eq_ignore_ascii_case("error"))
            .unwrap_or(false);
        normalized.push(NormalizedEvent::ToolUseResult {
            call_id,
            output,
            is_error,
        });
    }

    normalized
}

fn normalize_opencode_step_finish(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    match event
        .get("reason")
        .or_else(|| event.get("part").and_then(|part| part.get("reason")))
        .and_then(|v| v.as_str())
    {
        Some("tool-calls") => vec![],
        Some("error") => vec![NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Error,
            usage: None,
        }],
        _ => vec![NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Complete,
            usage: None,
        }],
    }
}

fn normalize_opencode_error(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    let message = event
        .get("error")
        .and_then(|error| error.get("data"))
        .and_then(|data| data.get("message"))
        .or_else(|| event.get("error").and_then(|error| error.get("message")))
        .or_else(|| event.get("message"))
        .and_then(|v| v.as_str())
        .unwrap_or("opencode error")
        .to_string();

    vec![
        NormalizedEvent::Error {
            message,
            recoverable: false,
        },
        NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Error,
            usage: None,
        },
    ]
}

fn normalize_opencode_complete(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    let mut normalized = Vec::new();
    if let Some(session_id) = opencode_session_id(event) {
        normalized.push(NormalizedEvent::SessionResolved {
            session_id: session_id.to_string(),
        });
    }
    normalized.push(NormalizedEvent::TurnComplete {
        reason: TurnEndReason::Complete,
        usage: None,
    });
    normalized
}

fn opencode_session_id(event: &serde_json::Value) -> Option<&str> {
    event
        .get("sessionID")
        .or_else(|| event.get("session_id"))
        .or_else(|| event.get("sessionId"))
        .or_else(|| event.get("part").and_then(|part| part.get("sessionID")))
        .or_else(|| event.get("part").and_then(|part| part.get("session_id")))
        .or_else(|| event.get("part").and_then(|part| part.get("sessionId")))
        .and_then(|v| v.as_str())
}

fn raw(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    vec![NormalizedEvent::Raw {
        agent: "opencode".to_string(),
        raw: event.clone(),
    }]
}

#[derive(Debug, Deserialize)]
struct OpencodeSessionListEntry {
    id: String,
    title: Option<String>,
    updated: Option<i64>,
    created: Option<i64>,
    directory: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpencodeExport {
    messages: Vec<OpencodeExportMessage>,
}

#[derive(Debug, Deserialize)]
struct OpencodeExportMessage {
    info: OpencodeExportMessageInfo,
    #[serde(default)]
    parts: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct OpencodeExportMessageInfo {
    role: String,
    time: Option<OpencodeExportTime>,
}

#[derive(Debug, Deserialize)]
struct OpencodeExportTime {
    created: Option<i64>,
}

fn parse_session_list(
    raw: &str,
    project_path: &str,
) -> Result<Vec<crate::session::Session>, String> {
    let json = extract_json(raw).ok_or_else(|| "No JSON session list found".to_string())?;
    let entries: Vec<OpencodeSessionListEntry> =
        serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut sessions = entries
        .into_iter()
        .filter(|entry| {
            entry
                .directory
                .as_deref()
                .map(|dir| same_path(dir, project_path))
                .unwrap_or(false)
        })
        .map(|entry| {
            let started_at = entry.created.and_then(datetime_from_millis);
            let last_active = entry.updated.and_then(datetime_from_millis);
            crate::session::Session {
                id: entry.id.clone(),
                path: PathBuf::from(project_path).join(format!("{}.opencode.json", entry.id)),
                messages: Vec::new(),
                started_at,
                display_name: entry.title.filter(|title| !title.trim().is_empty()),
                last_active,
                project_path: Some(project_path.to_string()),
            }
        })
        .collect::<Vec<_>>();

    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(sessions)
}

fn parse_project_list(raw: &str) -> Result<Vec<crate::project::Project>, String> {
    let json = extract_json(raw).ok_or_else(|| "No JSON session list found".to_string())?;
    let entries: Vec<OpencodeSessionListEntry> =
        serde_json::from_str(json).map_err(|e| e.to_string())?;

    let mut grouped: HashMap<String, (String, usize, Option<i64>)> = HashMap::new();
    for entry in entries {
        let Some(directory) = entry.directory.filter(|dir| !dir.trim().is_empty()) else {
            continue;
        };
        if !PathBuf::from(&directory).is_dir() {
            continue;
        }

        let key = path_key(&directory);
        let timestamp = entry.updated.or(entry.created);
        let item = grouped.entry(key).or_insert((directory, 0, None));
        item.1 += 1;
        if timestamp > item.2 {
            item.2 = timestamp;
        }
    }

    let mut projects = grouped
        .into_values()
        .filter_map(|(directory, session_count, last_active_ms)| {
            crate::project::project_from_agent_path(
                &directory,
                "opencode",
                session_count,
                last_active_ms.and_then(format_millis_local),
            )
        })
        .collect::<Vec<_>>();
    projects.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(projects)
}

fn scan_projects_from_db() -> Result<Vec<crate::project::Project>, String> {
    let db_path = opencode_db_path()?;
    scan_projects_from_db_path(&db_path)
}

fn scan_projects_from_db_path(db_path: &Path) -> Result<Vec<crate::project::Project>, String> {
    if !db_path.is_file() {
        return Ok(Vec::new());
    }

    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT directory, COUNT(*), MAX(COALESCE(time_updated, time_created)) \
             FROM session \
             WHERE directory IS NOT NULL AND directory != '' \
             GROUP BY directory",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut grouped: HashMap<String, (String, usize, Option<i64>)> = HashMap::new();
    for row in rows {
        let (directory, session_count, timestamp) = row.map_err(|e| e.to_string())?;
        if !PathBuf::from(&directory).is_dir() {
            continue;
        }

        let key = path_key(&directory);
        let item = grouped.entry(key).or_insert((directory, 0, None));
        item.1 += session_count.max(0) as usize;
        if timestamp > item.2 {
            item.2 = timestamp;
        }
    }

    let mut projects = grouped
        .into_values()
        .filter_map(|(directory, session_count, last_active_ms)| {
            crate::project::project_from_agent_path(
                &directory,
                "opencode",
                session_count,
                last_active_ms.and_then(format_millis_local),
            )
        })
        .collect::<Vec<_>>();
    projects.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(projects)
}

fn parse_export_messages(raw: &str) -> Result<Vec<crate::session::Message>, String> {
    let json = extract_json(raw).ok_or_else(|| "No JSON export found".to_string())?;
    let exported: OpencodeExport = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut messages = Vec::new();

    for message in exported.messages {
        if message.info.role != "user" && message.info.role != "assistant" {
            continue;
        }

        let mut content = Vec::new();
        for part in &message.parts {
            append_part_blocks(part, &mut content);
        }

        if content.is_empty() {
            continue;
        }

        messages.push(crate::session::Message {
            role: message.info.role,
            content,
            timestamp: message.info.time.and_then(|time| time.created),
        });
    }

    Ok(messages)
}

/// Map a single opencode message `part` JSON value into normalized content
/// blocks. Shared by the CLI-export path and the SQLite path so both produce
/// identical content (and therefore identical search results).
fn append_part_blocks(part: &serde_json::Value, content: &mut Vec<crate::session::ContentBlock>) {
    let part_type = part
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    match part_type {
        "text" => {
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                if !text.trim().is_empty() {
                    content.push(crate::session::ContentBlock::Text {
                        text: text.to_string(),
                    });
                }
            }
        }
        "thinking" | "reasoning" => {
            if let Some(text) = part
                .get("thinking")
                .or_else(|| part.get("text"))
                .and_then(|v| v.as_str())
            {
                if !text.trim().is_empty() {
                    content.push(crate::session::ContentBlock::Thinking {
                        thinking: text.to_string(),
                    });
                }
            }
        }
        "tool" => {
            let call_id = part
                .get("callID")
                .or_else(|| part.get("call_id"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let tool = part
                .get("tool")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let state = part.get("state").unwrap_or(part);
            let input = state
                .get("input")
                .cloned()
                .unwrap_or(serde_json::Value::Null);

            if !call_id.is_empty() {
                content.push(crate::session::ContentBlock::ToolUse {
                    id: call_id.clone(),
                    name: tool,
                    input,
                });

                if let Some(output) = state.get("output").cloned() {
                    content.push(crate::session::ContentBlock::ToolResult {
                        tool_use_id: call_id,
                        content: output,
                    });
                }
            }
        }
        _ => {}
    }
}

/// Read a session's messages directly from the opencode SQLite store, avoiding
/// an `opencode export` subprocess spawn per session.
fn read_session_messages_from_db(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<crate::session::Message>, String> {
    let msg_rows: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare_cached(
                "SELECT id, data FROM message WHERE session_id = ?1 ORDER BY time_created ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([session_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut part_stmt = conn
        .prepare_cached("SELECT data FROM part WHERE message_id = ?1 ORDER BY time_created ASC")
        .map_err(|e| e.to_string())?;

    let mut messages = Vec::new();
    for (msg_id, msg_data) in msg_rows {
        let info: serde_json::Value = match serde_json::from_str(&msg_data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let role = info
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if role != "user" && role != "assistant" {
            continue;
        }
        let timestamp = info
            .get("time")
            .and_then(|t| t.get("created"))
            .and_then(|v| v.as_i64());

        let mut content = Vec::new();
        let part_rows = part_stmt
            .query_map([&msg_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for raw in part_rows.filter_map(|r| r.ok()) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                append_part_blocks(&value, &mut content);
            }
        }

        if content.is_empty() {
            continue;
        }
        messages.push(crate::session::Message {
            role: role.to_string(),
            content,
            timestamp,
        });
    }
    Ok(messages)
}

/// List sessions for a project directly from the opencode SQLite store,
/// hydrating messages in the same pass without spawning any subprocess.
fn list_sessions_from_db(
    db_path: &Path,
    project_path: &str,
) -> Result<Vec<crate::session::Session>, String> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;

    let session_rows: Vec<(String, String, i64, i64)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, title, directory, time_created, time_updated \
                 FROM session WHERE directory IS NOT NULL AND directory != ''",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok())
            .filter(|(_, _, dir, _, _)| same_path(dir, project_path))
            .map(|(id, title, _, created, updated)| (id, title, created, updated))
            .collect()
    };

    let mut sessions = Vec::new();
    for (id, title, created, updated) in session_rows {
        let messages = read_session_messages_from_db(&conn, &id).unwrap_or_default();
        sessions.push(crate::session::Session {
            path: PathBuf::from(project_path).join(format!("{}.opencode.json", id)),
            id,
            messages,
            started_at: datetime_from_millis(created),
            display_name: Some(title).filter(|t| !t.trim().is_empty()),
            last_active: datetime_from_millis(updated),
            project_path: Some(project_path.to_string()),
        });
    }

    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(sessions)
}

#[cfg(test)]
fn hydrate_session_messages<F>(sessions: &mut [crate::session::Session], mut export_raw: F)
where
    F: FnMut(&str) -> Result<String, String>,
{
    for session in sessions {
        if !session.messages.is_empty() {
            continue;
        }

        if let Ok(raw) = export_raw(&session.id) {
            if let Ok(messages) = parse_export_messages(&raw) {
                session.messages = messages;
            }
        }
    }
}

fn datetime_from_millis(value: i64) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis(value)
}

fn extract_json(raw: &str) -> Option<&str> {
    let start = raw.find(|ch| ch == '{' || ch == '[')?;
    let end = raw.rfind(|ch| ch == '}' || ch == ']')?;
    if end > start {
        Some(raw[start..=end].trim())
    } else {
        None
    }
}

fn same_path(left: &str, right: &str) -> bool {
    path_key(left) == path_key(right)
}

fn path_key(value: &str) -> String {
    let path = std::path::Path::new(value);
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_else(|_| {
            let p = std::path::PathBuf::from(value);
            let s = p.to_string_lossy().to_string();
            // Normalize path separators so "/a/b" and "\a\b" compare equal
            s.replace('/', std::path::MAIN_SEPARATOR_STR)
                .trim_end_matches(std::path::MAIN_SEPARATOR)
                .to_ascii_lowercase()
        })
}

fn format_millis_local(value: i64) -> Option<String> {
    DateTime::from_timestamp_millis(value).map(|datetime: DateTime<Utc>| {
        datetime
            .with_timezone(&Local)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    })
}

fn opencode_config_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    Ok(home.join(".config").join("opencode"))
}

fn opencode_db_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot find home directory".to_string())?;
    Ok(home
        .join(".local")
        .join("share")
        .join("opencode")
        .join("opencode.db"))
}

fn opencode_config_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = opencode_config_dir()?;
    let json = dir.join("opencode.json");
    if json.exists() {
        return Ok(json);
    }
    let jsonc = dir.join("opencode.jsonc");
    if jsonc.exists() {
        return Ok(jsonc);
    }
    Ok(json)
}

fn opencode_backup_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = opencode_config_dir()?.join("backups");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn read_opencode_config_value() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let path = opencode_config_path()?;
    if !path.exists() {
        return Ok(serde_json::json!({
            "$schema": "https://opencode.ai/config.json"
        }));
    }
    let content = std::fs::read_to_string(path)?;
    parse_json_or_jsonc(&content).map_err(|e| e.into())
}

fn parse_json_or_jsonc(raw: &str) -> Result<serde_json::Value, serde_json::Error> {
    serde_json::from_str(raw).or_else(|_| serde_json::from_str(&strip_json_comments(raw)))
}

fn strip_json_comments(raw: &str) -> String {
    let mut output = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if in_string {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            output.push(ch);
            continue;
        }

        if ch == '/' && chars.peek() == Some(&'/') {
            chars.next();
            for next in chars.by_ref() {
                if next == '\n' {
                    output.push('\n');
                    break;
                }
            }
            continue;
        }

        if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut prev = '\0';
            for next in chars.by_ref() {
                if prev == '*' && next == '/' {
                    break;
                }
                prev = next;
            }
            continue;
        }

        output.push(ch);
    }

    output
}

#[cfg(test)]
fn parse_opencode_config(raw: &str) -> Result<crate::config::ClaudeConfig, String> {
    let value = parse_json_or_jsonc(raw).map_err(|e| e.to_string())?;
    opencode_value_to_shared_config(&value)
}

fn opencode_value_to_shared_config(
    value: &serde_json::Value,
) -> Result<crate::config::ClaudeConfig, String> {
    let mut config = crate::config::ClaudeConfig::default();
    config.model = value
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    config.small_model = value
        .get("small_model")
        .or_else(|| value.get("smallModel"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if let Some(mcp) = value.get("mcp").and_then(|v| v.as_object()) {
        let mut servers = HashMap::new();
        for (name, server) in mcp {
            if let Some(server_obj) = server.as_object() {
                let command_value = server_obj.get("command");
                let (command, args) = match command_value {
                    Some(serde_json::Value::Array(items)) => {
                        let mut values = items.iter().filter_map(|item| item.as_str());
                        let command = values.next().map(|s| s.to_string());
                        let args = values.map(|s| s.to_string()).collect::<Vec<_>>();
                        (command, if args.is_empty() { None } else { Some(args) })
                    }
                    Some(serde_json::Value::String(command)) => (
                        Some(command.clone()),
                        server_obj.get("args").and_then(|v| {
                            v.as_array().map(|arr| {
                                arr.iter()
                                    .filter_map(|item| item.as_str().map(|s| s.to_string()))
                                    .collect::<Vec<_>>()
                            })
                        }),
                    ),
                    _ => (None, None),
                };

                servers.insert(
                    name.clone(),
                    crate::config::McpServerConfig {
                        command,
                        args,
                        env: server_obj
                            .get("environment")
                            .or_else(|| server_obj.get("env"))
                            .and_then(|v| v.as_object())
                            .map(|map| {
                                map.iter()
                                    .map(|(k, v)| (k.clone(), v.clone()))
                                    .collect::<HashMap<_, _>>()
                            }),
                        cwd: server_obj
                            .get("cwd")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        server_type: server_obj
                            .get("type")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        url: server_obj
                            .get("url")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                    },
                );
            }
        }
        if !servers.is_empty() {
            config.mcp_servers = Some(servers);
        }
    }

    if let Some(plugins) = value.get("plugin").and_then(|v| v.as_array()) {
        let enabled = plugins
            .iter()
            .filter_map(|item| item.as_str())
            .map(|name| (name.to_string(), true))
            .collect::<HashMap<_, _>>();
        if !enabled.is_empty() {
            config.enabled_plugins = Some(enabled);
        }
    }

    Ok(config)
}

fn merge_opencode_config(
    mut existing: serde_json::Value,
    config: &crate::config::ClaudeConfig,
) -> Result<serde_json::Value, String> {
    if !existing.is_object() {
        existing = serde_json::json!({});
    }
    let obj = existing
        .as_object_mut()
        .ok_or_else(|| "opencode config must be an object".to_string())?;

    if !obj.contains_key("$schema") {
        obj.insert(
            "$schema".to_string(),
            serde_json::json!("https://opencode.ai/config.json"),
        );
    }

    set_or_remove_string(obj, "model", config.model.as_deref());
    set_or_remove_string(obj, "small_model", config.small_model.as_deref());

    if let Some(plugins) = &config.enabled_plugins {
        let enabled = plugins
            .iter()
            .filter(|(_, enabled)| **enabled)
            .map(|(name, _)| serde_json::Value::String(name.clone()))
            .collect::<Vec<_>>();
        if enabled.is_empty() {
            obj.remove("plugin");
        } else {
            obj.insert("plugin".to_string(), serde_json::Value::Array(enabled));
        }
    }

    if let Some(mcp_servers) = &config.mcp_servers {
        let mut existing_mcp = obj
            .remove("mcp")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        for (name, server) in mcp_servers {
            let mut server_obj = existing_mcp
                .remove(name)
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default();

            if let Some(server_type) = &server.server_type {
                server_obj.insert("type".to_string(), serde_json::json!(server_type));
            } else if server.command.is_some() {
                server_obj.insert("type".to_string(), serde_json::json!("local"));
            } else if server.url.is_some() {
                server_obj.insert("type".to_string(), serde_json::json!("remote"));
            }

            if let Some(command) = &server.command {
                let mut command_parts = vec![serde_json::Value::String(command.clone())];
                if let Some(args) = &server.args {
                    command_parts.extend(args.iter().cloned().map(serde_json::Value::String));
                }
                server_obj.insert(
                    "command".to_string(),
                    serde_json::Value::Array(command_parts),
                );
            }
            if let Some(env) = &server.env {
                server_obj.insert(
                    "environment".to_string(),
                    serde_json::Value::Object(env.clone().into_iter().collect()),
                );
            }
            set_or_remove_string(&mut server_obj, "cwd", server.cwd.as_deref());
            set_or_remove_string(&mut server_obj, "url", server.url.as_deref());
            existing_mcp.insert(name.clone(), serde_json::Value::Object(server_obj));
        }
        obj.insert("mcp".to_string(), serde_json::Value::Object(existing_mcp));
    }

    Ok(existing)
}

fn set_or_remove_string(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: Option<&str>,
) {
    if let Some(value) = value.filter(|v| !v.trim().is_empty()) {
        obj.insert(
            key.to_string(),
            serde_json::Value::String(value.to_string()),
        );
    } else {
        obj.remove(key);
    }
}

fn load_opencode_config() -> Result<crate::config::ClaudeConfig, Box<dyn std::error::Error>> {
    let value = read_opencode_config_value()?;
    opencode_value_to_shared_config(&value).map_err(|e| e.into())
}

fn save_opencode_config(
    config: &crate::config::ClaudeConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    let path = opencode_config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    backup_opencode_config()?;
    let existing = read_opencode_config_value()?;
    let merged = merge_opencode_config(existing, config).map_err(|e| e.to_string())?;
    crate::util::atomic_write(&path, serde_json::to_string_pretty(&merged)?.as_bytes())?;
    Ok(())
}

fn backup_opencode_config() -> Result<Option<PathBuf>, Box<dyn std::error::Error>> {
    let src = opencode_config_path()?;
    if !src.exists() {
        return Ok(None);
    }
    let backup_dir = opencode_backup_dir()?;
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let ext = src
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("json");
    let dst = backup_dir.join(format!("opencode_{}.{}", timestamp, ext));
    std::fs::copy(src, &dst)?;
    Ok(Some(dst))
}

fn list_opencode_backups() -> Result<Vec<crate::config::BackupEntry>, Box<dyn std::error::Error>> {
    let backup_dir = opencode_backup_dir()?;
    let mut backups = Vec::new();
    for entry in std::fs::read_dir(backup_dir)?.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if !(name.ends_with(".json") || name.ends_with(".jsonc")) {
            continue;
        }
        let timestamp = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .strip_prefix("opencode_")
            .and_then(|s| {
                chrono::NaiveDateTime::parse_from_str(s, "%Y%m%d_%H%M%S")
                    .ok()
                    .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
            });
        backups.push(crate::config::BackupEntry {
            name,
            path: path.to_string_lossy().to_string(),
            timestamp,
        });
    }
    backups.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(backups)
}

fn restore_opencode_backup(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    let _: serde_json::Value = parse_json_or_jsonc(&content)?;
    let dst = opencode_config_path()?;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(dst, content)?;
    Ok(())
}

fn export_opencode_config(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let src = opencode_config_path()?;
    let content = if src.exists() {
        std::fs::read_to_string(src)?
    } else {
        serde_json::to_string_pretty(&serde_json::json!({
            "$schema": "https://opencode.ai/config.json"
        }))?
    };
    std::fs::write(path, content)?;
    Ok(())
}

fn import_opencode_config(
    path: &str,
) -> Result<crate::config::ClaudeConfig, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    let value = parse_json_or_jsonc(&content)?;
    let config = opencode_value_to_shared_config(&value).map_err(|e| e.to_string())?;
    backup_opencode_config()?;
    let dst = opencode_config_path()?;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(dst, serde_json::to_string_pretty(&value)?)?;
    Ok(config)
}

use crate::agent::traits::{
    AgentManifest, ConfigAdapter, EventNormalizer, ProjectAdapter, SessionAdapter, TerminalAdapter,
    TransportAdapter,
};
impl AgentManifest for OpencodeAdapter {
    fn info(&self) -> AgentInfo {
        AgentInfo {
            id: "opencode".to_string(),
            display_name: "Open Code".to_string(),
            version: "1.0".to_string(),
            icon: "code".to_string(),
            logo_path: None,
            enabled: true,
        }
    }

    fn capabilities(&self) -> AgentCapabilities {
        use AgentCapabilities as C;
        C::RESUME_BY_ID
            | C::SESSION_FORK
            | C::SESSION_LIST
            | C::SESSION_DELETE
            | C::SESSION_EXPORT
            | C::SESSION_IMPORT
            | C::FILE_INPUT
            | C::STREAM_TEXT_DELTA
            | C::STREAM_THINKING
            | C::ABORT
            | C::CONFIG_GLOBAL
            | C::SUBAGENT_DISPATCH
            | C::SUBAGENT_RECEIVE
            | C::RPC_BIDIRECTIONAL
    }

    fn install_hint(&self) -> Option<String> {
        Some("npm install -g opencode".to_string())
    }

    fn native_install_command(&self) -> Option<String> {
        Some("choco install opencode".to_string())
    }

    fn install_package_manager(&self) -> Option<String> {
        Some("choco".to_string())
    }

    fn probe_sync(&self) -> AgentHealth {
        let candidates = super::super::discovery::default_candidates_for("opencode");
        let cands: Vec<&str> = candidates.iter().map(|s| s.as_str()).collect();
        match super::super::discovery::probe_binary_sync("opencode", &cands) {
            Some(path) => {
                let version = super::super::discovery::version_of_sync(&path);
                AgentHealth {
                    installed: true,
                    version,
                    error: None,
                    binary_path: Some(path.to_string_lossy().to_string()),
                    last_checked_at: now_ms(),
                }
            }
            None => AgentHealth {
                installed: false,
                version: None,
                error: Some("opencode not found in PATH".to_string()),
                binary_path: None,
                last_checked_at: now_ms(),
            },
        }
    }
}

impl TransportAdapter for OpencodeAdapter {
    fn transport_surface(&self) -> crate::agent::TransportSurface {
        crate::agent::TransportSurface::AcpPreferred
    }

    fn build_chat_command(&self, req: ChatRequest) -> tokio::process::Command {
        let args = build_run_args(&req);

        #[cfg(target_os = "windows")]
        {
            let mut cmd = tokio::process::Command::new("opencode");
            cmd.args(&args).current_dir(&req.project_path);
            crate::process_command::tokio_no_window(&mut cmd);
            cmd
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut cmd = tokio::process::Command::new("opencode");
            cmd.args(&args).current_dir(&req.project_path);
            cmd
        }
    }

    fn build_acp_command(
        &self,
        _req: &crate::agent::ChatRequest,
    ) -> Result<crate::agent::AcpCommandSpec, String> {
        Ok(crate::agent::AcpCommandSpec {
            program: "opencode".to_string(),
            args: vec!["acp".to_string()],
            envs: Vec::new(),
        })
    }

    fn pipe_chat_stdin(&self) -> bool {
        false
    }

    fn abort_chat_sequence(&self) -> Option<&'static [u8]> {
        None
    }

    fn stderr_relay_as_events(&self) -> bool {
        true
    }

    fn treat_eof_as_complete_after_output(&self) -> bool {
        true
    }
}

impl ConfigAdapter for OpencodeAdapter {
    fn config_surface(&self) -> crate::agent::ConfigSurface {
        crate::agent::ConfigSurface::Structured {
            schema_id: "opencode-config".to_string(),
        }
    }

    fn load_config(&self) -> Result<serde_json::Value, String> {
        let config = load_opencode_config().map_err(|e| e.to_string())?;
        serde_json::to_value(config).map_err(|e| e.to_string())
    }

    fn save_config(&self, config: &serde_json::Value) -> Result<(), String> {
        let typed: crate::config::ClaudeConfig =
            serde_json::from_value(config.clone()).map_err(|e| format!("Invalid config: {}", e))?;
        save_opencode_config(&typed).map_err(|e| e.to_string())
    }

    fn config_templates(&self) -> Vec<crate::hub::ConfigTemplate> {
        vec![
            crate::hub::ConfigTemplate {
                id: "opencode-default".to_string(),
                name: "opencode 默认配置".to_string(),
                description: "保留 opencode 默认模型与 MCP 设置，仅创建基础配置结构".to_string(),
                config: serde_json::to_value(crate::config::ClaudeConfig::default())
                    .unwrap_or_default(),
            },
            crate::hub::ConfigTemplate {
                id: "opencode-glm".to_string(),
                name: "opencode GLM 模型".to_string(),
                description: "设置 opencode 的主模型与小模型为 GLM".to_string(),
                config: serde_json::to_value(crate::config::ClaudeConfig {
                    model: Some("zhipuai-coding-plan/glm-5.1".to_string()),
                    small_model: Some("zhipuai-coding-plan/glm-5.1".to_string()),
                    ..Default::default()
                })
                .unwrap_or_default(),
            },
        ]
    }

    fn config_format(&self) -> Option<String> {
        Some("json".to_string())
    }

    fn load_raw_config(&self) -> Result<String, String> {
        let path = opencode_config_path().map_err(|e| e.to_string())?;
        if !path.exists() {
            return Ok(String::new());
        }
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    }

    fn save_raw_config(&self, content: &str) -> Result<(), String> {
        let cleaned = strip_json_comments(content);
        let _: serde_json::Value =
            serde_json::from_str(&cleaned).map_err(|e| format!("Invalid JSON: {}", e))?;
        backup_opencode_config().map_err(|e| e.to_string())?;
        let path = opencode_config_path().map_err(|e| e.to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        crate::util::atomic_write(&path, content.as_bytes()).map_err(|e| e.to_string())
    }

    fn list_backups(&self) -> Result<Vec<crate::config::BackupEntry>, String> {
        list_opencode_backups().map_err(|e| e.to_string())
    }

    fn restore_backup(&self, path: &str) -> Result<(), String> {
        restore_opencode_backup(path).map_err(|e| e.to_string())
    }

    fn export_config(&self, path: &str) -> Result<(), String> {
        export_opencode_config(path).map_err(|e| e.to_string())
    }

    fn import_config(&self, path: &str) -> Result<serde_json::Value, String> {
        let config = import_opencode_config(path).map_err(|e| e.to_string())?;
        serde_json::to_value(config).map_err(|e| e.to_string())
    }
}

impl SessionAdapter for OpencodeAdapter {
    fn list_sessions(&self, encoded_name: &str) -> Result<Vec<crate::session::Session>, String> {
        let project_path = crate::project::decode_project_path(encoded_name);

        // Fast path: read sessions and their messages directly from the local
        // SQLite store. This avoids spawning one `opencode export` subprocess
        // per session, which made opening a project's session list very slow.
        if let Ok(db_path) = opencode_db_path() {
            if db_path.is_file() {
                if let Ok(sessions) = list_sessions_from_db(&db_path, &project_path) {
                    return Ok(sessions);
                }
            }
        }

        // Fallback for older installs without the SQLite store.
        let mut command = std::process::Command::new("opencode");
        let output = crate::process_command::std_no_window(
            command
                .args(["session", "list", "--format", "json", "--max-count", "500"])
                .current_dir(&project_path),
        )
        .output()
        .map_err(|e| format!("Failed to list opencode sessions: {e}"))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        parse_session_list(&String::from_utf8_lossy(&output.stdout), &project_path)
    }

    fn get_session_messages(
        &self,
        session_id: &str,
        encoded_name: &str,
    ) -> Result<Vec<crate::session::Message>, String> {
        // Fast path: read directly from the local SQLite store.
        if let Ok(db_path) = opencode_db_path() {
            if db_path.is_file() {
                if let Ok(conn) = Connection::open_with_flags(
                    &db_path,
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                ) {
                    if let Ok(messages) = read_session_messages_from_db(&conn, session_id) {
                        return Ok(messages);
                    }
                }
            }
        }

        // Fallback: opencode CLI export.
        let project_path = crate::project::decode_project_path(encoded_name);
        let mut command = std::process::Command::new("opencode");
        let output = crate::process_command::std_no_window(
            command
                .args(["export", session_id])
                .current_dir(&project_path),
        )
        .output()
        .map_err(|e| format!("Failed to export opencode session: {e}"))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        parse_export_messages(&String::from_utf8_lossy(&output.stdout))
    }

    fn load_history(&self) -> Vec<crate::history::HistoryEntry> {
        vec![]
    }
}

impl TerminalAdapter for OpencodeAdapter {
    fn open_in_terminal(
        &self,
        project_path: &str,
        resume_session_id: Option<&str>,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        let command = resume_session_id
            .map(|sid| self.build_resume_command(sid))
            .unwrap_or_else(|| self.build_launch_command());
        let window_id = resume_session_id
            .map(|sid| crate::agent::command_config::terminal_window_id("opencode", sid));
        crate::command::open_agent_terminal(project_path, &command, window_id.as_deref())
    }

    fn open_in_terminal_with_command(
        &self,
        project_path: &str,
        command: &str,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        crate::command::open_in_terminal_with_command(project_path, command)
    }

    fn build_resume_command(&self, session_id: &str) -> String {
        format!("opencode --session {session_id}")
    }

    fn build_launch_command(&self) -> String {
        "opencode".to_string()
    }

    fn built_in_commands(&self) -> Vec<crate::agent::command_config::AgentCommandPreset> {
        use crate::agent::command_config::AgentCommandPreset;
        vec![
            AgentCommandPreset {
                name: "opencode --version".into(),
                command: "opencode --version".into(),
            },
            AgentCommandPreset {
                name: "opencode session list".into(),
                command: "opencode session list".into(),
            },
            AgentCommandPreset {
                name: "opencode models".into(),
                command: "opencode models".into(),
            },
            AgentCommandPreset {
                name: "opencode mcp list".into(),
                command: "opencode mcp list".into(),
            },
            AgentCommandPreset {
                name: "opencode agent list".into(),
                command: "opencode agent list".into(),
            },
            AgentCommandPreset {
                name: "opencode debug config".into(),
                command: "opencode debug config".into(),
            },
            AgentCommandPreset {
                name: "opencode run".into(),
                command: "opencode run \"Say hello\"".into(),
            },
        ]
    }
}

impl ProjectAdapter for OpencodeAdapter {
    fn scan_projects(&self) -> Vec<crate::project::Project> {
        match scan_projects_from_db() {
            Ok(projects) if !projects.is_empty() => return projects,
            _ => {}
        }

        let output = match {
            let mut command = std::process::Command::new("opencode");
            crate::process_command::std_no_window(command.args([
                "session",
                "list",
                "--format",
                "json",
                "--max-count",
                "500",
            ]))
            .output()
        } {
            Ok(output) => output,
            Err(_) => return Vec::new(),
        };

        if !output.status.success() {
            return Vec::new();
        }

        parse_project_list(&String::from_utf8_lossy(&output.stdout)).unwrap_or_default()
    }

    fn add_project(&self, path: &str) -> Option<crate::project::Project> {
        crate::project::add_project(path)
    }

    fn decode_project_path(&self, encoded: &str) -> String {
        crate::project::decode_project_path(encoded)
    }

    fn encode_project_path(&self, path: &str) -> String {
        crate::project::encode_project_path(path)
    }

    fn get_level1_dir(&self, path: &str) -> Option<String> {
        crate::project::get_level1_dir(path)
    }

    fn init_project(&self, project_path: &str) -> Result<bool, String> {
        let command = self.build_init_command();
        crate::command::open_in_terminal_with_command(project_path, &command)
            .map(|_| true)
            .map_err(|e| e.to_string())
    }

    fn load_project_settings(
        &self,
        _path: &str,
    ) -> Result<crate::project_config::ProjectSettings, String> {
        Ok(crate::project_config::ProjectSettings::default())
    }

    fn load_project_settings_local(
        &self,
        _path: &str,
    ) -> Result<crate::project_config::ProjectSettings, String> {
        Ok(crate::project_config::ProjectSettings::default())
    }

    fn save_project_settings(
        &self,
        _path: &str,
        _settings: &crate::project_config::ProjectSettings,
    ) -> Result<(), String> {
        Err("Not supported".to_string())
    }

    fn save_project_settings_local(
        &self,
        _path: &str,
        _settings: &crate::project_config::ProjectSettings,
    ) -> Result<(), String> {
        Err("Not supported".to_string())
    }

    fn load_claude_md(&self, _path: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
}

impl EventNormalizer for OpencodeAdapter {
    fn parse_stream_event(&self, event: &serde_json::Value) -> String {
        match event_type(event) {
            Some("step_start") | Some("step-start") => "session",
            Some("text") => "delta",
            Some("reasoning") => "thinking",
            Some("tool_use") => "tool",
            Some("step_finish") | Some("step-finish") => "result",
            Some("error") => "error",
            Some("text_delta") => "delta",
            Some("message") => "message",
            Some("result") => "result",
            Some(t) => t,
            None => "unknown",
        }
        .to_string()
    }
}

fn build_run_args(req: &ChatRequest) -> Vec<String> {
    let mut args = vec![
        "run".to_string(),
        "--format".to_string(),
        "json".to_string(),
    ];
    if let Some(ref sid) = req.session_id {
        args.push("--session".to_string());
        args.push(sid.clone());
    }
    args.push(req.message.clone());
    args
}

fn now_ms() -> i64 {
    crate::util::now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::normalized::{NormalizedEvent, TurnEndReason};

    #[test]
    fn uses_open_code_display_name() {
        assert_eq!(OpencodeAdapter::new().info().display_name, "Open Code");
    }

    #[test]
    fn parses_opencode_session_list_for_project() {
        let raw = r#"[
            {
                "id": "ses_1",
                "title": "打招呼与确认回复请求",
                "updated": 1779924225844,
                "created": 1779924224291,
                "directory": "D:\\MyCodes\\jishu-hub"
            },
            {
                "id": "ses_other",
                "title": "Other",
                "updated": 1779924000000,
                "created": 1779923000000,
                "directory": "E:\\Other"
            }
        ]"#;

        let sessions = parse_session_list(raw, "D:\\MyCodes\\jishu-hub").unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "ses_1");
        assert_eq!(
            sessions[0].display_name.as_deref(),
            Some("打招呼与确认回复请求")
        );
        assert_eq!(
            sessions[0].project_path.as_deref(),
            Some("D:\\MyCodes\\jishu-hub")
        );
        assert_eq!(
            sessions[0].last_active.unwrap().timestamp_millis(),
            1779924225844
        );
    }

    #[test]
    fn parses_opencode_project_list_from_session_directories() {
        let root = std::env::temp_dir().join("jishu_opencode_project_list");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.to_string_lossy().replace('\\', "\\\\");
        let raw = format!(
            r#"[{{
                "id": "ses_1",
                "title": "One",
                "updated": 1779924225844,
                "created": 1779924224291,
                "directory": "{path}"
            }}, {{
                "id": "ses_2",
                "title": "Two",
                "updated": 1779924226000,
                "created": 1779924225000,
                "directory": "{path}"
            }}]"#
        );

        let projects = parse_project_list(&raw).unwrap();

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].session_count, 2);
        assert_eq!(projects[0].agent_ids, vec!["opencode".to_string()]);
        assert_eq!(projects[0].path, root);
        assert!(projects[0].last_active.is_some());

        let _ = std::fs::remove_dir_all(&projects[0].path);
    }

    #[test]
    fn scans_opencode_projects_from_sqlite_session_table() {
        let root = std::env::temp_dir().join("jishu_opencode_db_project");
        let db_dir = std::env::temp_dir().join("jishu_opencode_db_scan");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&db_dir);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&db_dir).unwrap();
        let db_path = db_dir.join("opencode.db");

        let conn = Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY,
                directory TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session (id, directory, time_created, time_updated) VALUES (?1, ?2, ?3, ?4)",
            (&"ses_1", &root.to_string_lossy(), &1779924224000_i64, &1779924225000_i64),
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session (id, directory, time_created, time_updated) VALUES (?1, ?2, ?3, ?4)",
            (&"ses_2", &root.to_string_lossy(), &1779924225000_i64, &1779924226000_i64),
        )
        .unwrap();
        drop(conn);

        let projects = scan_projects_from_db_path(&db_path).unwrap();

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].path, root);
        assert_eq!(projects[0].session_count, 2);
        assert_eq!(projects[0].agent_ids, vec!["opencode".to_string()]);
        assert!(projects[0].last_active.is_some());

        let _ = std::fs::remove_dir_all(&projects[0].path);
        let _ = std::fs::remove_dir_all(db_dir);
    }

    fn create_message_db(db_path: &Path, directory: &str) {
        let conn = Connection::open(db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        conn.execute(
            "INSERT INTO session (id, title, directory, time_created, time_updated) VALUES (?1,?2,?3,?4,?5)",
            ("ses_1", "Target", directory, 100_i64, 300_i64),
        ).unwrap();
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?1,?2,?3,?4,?5)",
            ("msg_1", "ses_1", 100_i64, 100_i64, r#"{"role":"user","time":{"created":100}}"#),
        ).unwrap();
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?1,?2,?3,?4,?5)",
            ("msg_2", "ses_1", 200_i64, 200_i64, r#"{"role":"assistant","time":{"created":200}}"#),
        ).unwrap();
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?1,?2,?3,?4,?5,?6)",
            ("prt_1", "msg_1", "ses_1", 100_i64, 100_i64, r#"{"type":"text","text":"hello world"}"#),
        ).unwrap();
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?1,?2,?3,?4,?5,?6)",
            ("prt_2", "msg_2", "ses_1", 201_i64, 201_i64, r#"{"type":"reasoning","text":"thinking deeply"}"#),
        ).unwrap();
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?1,?2,?3,?4,?5,?6)",
            ("prt_3", "msg_2", "ses_1", 202_i64, 202_i64, r#"{"type":"tool","tool":"read","callID":"call_1","state":{"input":{"filePath":"a.txt"},"output":"file body"}}"#),
        ).unwrap();
    }

    #[test]
    fn reads_session_messages_from_sqlite_store() {
        let dir = std::env::temp_dir().join("jishu_opencode_msg_db");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("opencode.db");
        create_message_db(&db_path, "D:\\proj");

        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        let messages = read_session_messages_from_db(&conn, "ses_1").unwrap();
        drop(conn);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].timestamp, Some(100));
        assert!(
            matches!(&messages[0].content[0], crate::session::ContentBlock::Text { text } if text == "hello world")
        );

        // reasoning -> thinking, tool -> tool_use + tool_result
        assert_eq!(messages[1].content.len(), 3);
        assert!(
            matches!(&messages[1].content[0], crate::session::ContentBlock::Thinking { thinking } if thinking == "thinking deeply")
        );
        assert!(
            matches!(&messages[1].content[1], crate::session::ContentBlock::ToolUse { name, id, .. } if name == "read" && id == "call_1")
        );
        assert!(
            matches!(&messages[1].content[2], crate::session::ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == "call_1")
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn lists_sessions_from_sqlite_with_directory_filter_and_messages() {
        let dir = std::env::temp_dir().join("jishu_opencode_list_db");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("opencode.db");
        create_message_db(&db_path, "D:\\proj");

        // Matching directory (case/slash-insensitive) hydrates messages.
        let sessions = list_sessions_from_db(&db_path, "d:/proj").unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "ses_1");
        assert_eq!(sessions[0].display_name.as_deref(), Some("Target"));
        assert_eq!(sessions[0].messages.len(), 2);

        // Non-matching directory yields nothing.
        let none = list_sessions_from_db(&db_path, "D:\\other").unwrap();
        assert!(none.is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn hydrates_list_sessions_with_exported_messages_for_search() {
        let mut sessions = parse_session_list(
            r#"[{
                "id": "ses_search",
                "title": "Search target",
                "updated": 1779924225844,
                "created": 1779924224291,
                "directory": "D:\\MyCodes\\jishu-hub"
            }]"#,
            r"D:\MyCodes\jishu-hub",
        )
        .unwrap();

        hydrate_session_messages(&mut sessions, |session_id| {
            assert_eq!(session_id, "ses_search");
            Ok(r#"{
                "messages": [{
                    "info": { "role": "assistant", "time": { "created": 1779924225844 } },
                    "parts": [{ "type": "text", "text": "Open Code searchable history" }]
                }]
            }"#
            .to_string())
        });

        assert_eq!(sessions[0].messages.len(), 1);
        match &sessions[0].messages[0].content[0] {
            crate::session::ContentBlock::Text { text } => {
                assert_eq!(text, "Open Code searchable history");
            }
            _ => panic!("expected hydrated text block"),
        }
    }

    #[test]
    fn parses_opencode_export_messages() {
        let raw = r#"{
            "info": {
                "id": "ses_1",
                "title": "打招呼",
                "directory": "D:\\MyCodes\\jishu-hub",
                "time": { "created": 1779924224291, "updated": 1779924225844 }
            },
            "messages": [
                {
                    "info": { "role": "user", "time": { "created": 1779924224348 } },
                    "parts": [{ "type": "text", "text": "你好" }]
                },
                {
                    "info": { "role": "assistant", "time": { "created": 1779924224453 } },
                    "parts": [
                        { "type": "step-start" },
                        { "type": "text", "text": "你好！有什么可以帮你的？" },
                        { "type": "step-finish", "reason": "stop" }
                    ]
                }
            ]
        }"#;

        let messages = parse_export_messages(raw).unwrap();

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
        match &messages[1].content[0] {
            crate::session::ContentBlock::Text { text } => {
                assert_eq!(text, "你好！有什么可以帮你的？");
            }
            other => panic!("Expected text block, got {:?}", other),
        }
    }

    #[test]
    fn parses_opencode_export_with_trailing_status_text() {
        let raw = r#"{
            "messages": [
                {
                    "info": { "role": "assistant", "time": { "created": 1779924224453 } },
                    "parts": [{ "type": "text", "text": "ok" }]
                }
            ]
        }
        Exporting session: ses_1"#;

        let messages = parse_export_messages(raw).unwrap();

        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn parses_opencode_config_into_shared_config_shape() {
        let raw = r#"{
            "model": "zhipuai-coding-plan/glm-5.1",
            "small_model": "zhipuai-coding-plan/glm-5.1",
            "mcp": {
                "local": {
                    "type": "local",
                    "command": ["npx", "-y", "@example/mcp"],
                    "environment": { "TOKEN": "abc" }
                },
                "remote": {
                    "type": "remote",
                    "url": "https://example.com/mcp"
                }
            },
            "plugin": ["@example/plugin"]
        }"#;

        let config = parse_opencode_config(raw).unwrap();

        assert_eq!(config.model.as_deref(), Some("zhipuai-coding-plan/glm-5.1"));
        assert_eq!(
            config.small_model.as_deref(),
            Some("zhipuai-coding-plan/glm-5.1")
        );
        let mcp = config.mcp_servers.unwrap();
        assert_eq!(mcp["local"].command.as_deref(), Some("npx"));
        assert_eq!(
            mcp["local"].args.as_ref().unwrap(),
            &vec!["-y".to_string(), "@example/mcp".to_string()]
        );
        assert_eq!(
            mcp["local"].env.as_ref().unwrap()["TOKEN"],
            serde_json::json!("abc")
        );
        assert_eq!(
            mcp["remote"].url.as_deref(),
            Some("https://example.com/mcp")
        );
        assert_eq!(
            config.enabled_plugins.unwrap().get("@example/plugin"),
            Some(&true)
        );
    }

    #[test]
    fn merges_shared_config_back_to_opencode_json() {
        let existing = serde_json::json!({
            "$schema": "https://opencode.ai/config.json",
            "provider": { "demo": { "options": { "apiKey": "keep" } } },
            "model": "old",
            "small_model": "old-small",
            "mcp": {}
        });
        let mut config = crate::config::ClaudeConfig::default();
        config.model = Some("new/model".to_string());
        config.small_model = Some("new/small".to_string());
        config.enabled_plugins = Some(std::collections::HashMap::from([(
            "@example/plugin".to_string(),
            true,
        )]));

        let merged = merge_opencode_config(existing, &config).unwrap();

        assert_eq!(merged["provider"]["demo"]["options"]["apiKey"], "keep");
        assert_eq!(merged["model"], "new/model");
        assert_eq!(merged["small_model"], "new/small");
        assert_eq!(merged["plugin"][0], "@example/plugin");
    }

    #[test]
    fn normalizes_opencode_text_delta() {
        let event = serde_json::json!({
            "type": "text_delta",
            "text": "hello"
        });

        assert_eq!(
            normalize_stream_event(&event),
            vec![NormalizedEvent::TextDelta {
                delta: "hello".to_string()
            }]
        );
    }

    #[test]
    fn normalizes_opencode_idle_as_complete() {
        let event = serde_json::json!({
            "type": "session.idle",
            "sessionID": "open-session"
        });

        assert_eq!(
            normalize_stream_event(&event),
            vec![
                NormalizedEvent::SessionResolved {
                    session_id: "open-session".to_string()
                },
                NormalizedEvent::TurnComplete {
                    reason: TurnEndReason::Complete,
                    usage: None,
                },
            ]
        );
    }

    #[test]
    fn builds_opencode_run_json_args() {
        assert_eq!(
            build_run_args(&ChatRequest {
                project_path: "D:\\MyCodes\\jishu-hub".to_string(),
                session_id: None,
                message: "hello opencode".to_string(),
            }),
            vec!["run", "--format", "json", "hello opencode"]
        );
    }

    #[test]
    fn builds_opencode_run_json_resume_args() {
        assert_eq!(
            build_run_args(&ChatRequest {
                project_path: "D:\\MyCodes\\jishu-hub".to_string(),
                session_id: Some("ses_123".to_string()),
                message: "continue".to_string(),
            }),
            vec![
                "run",
                "--format",
                "json",
                "--session",
                "ses_123",
                "continue"
            ]
        );
    }

    #[test]
    fn normalizes_opencode_jsonl_events() {
        let start = serde_json::json!({
            "type": "step_start",
            "sessionID": "ses_abc"
        });
        assert_eq!(
            normalize_stream_event(&start),
            vec![NormalizedEvent::SessionResolved {
                session_id: "ses_abc".to_string()
            }]
        );

        let text = serde_json::json!({
            "type": "text",
            "text": "hello"
        });
        assert_eq!(
            normalize_stream_event(&text),
            vec![NormalizedEvent::TextDelta {
                delta: "hello".to_string()
            }]
        );

        let finish = serde_json::json!({
            "type": "step_finish",
            "reason": "stop"
        });
        assert_eq!(
            normalize_stream_event(&finish),
            vec![NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                usage: None,
            }]
        );

        let finish_hyphen = serde_json::json!({
            "type": "step-finish",
            "sessionID": "ses_abc",
            "part": {
                "type": "step-finish",
                "reason": "stop"
            }
        });
        assert_eq!(
            normalize_stream_event(&finish_hyphen),
            vec![NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                usage: None,
            }]
        );

        let tool_step = serde_json::json!({
            "type": "step_finish",
            "part": {
                "reason": "tool-calls"
            }
        });
        assert_eq!(
            normalize_stream_event(&tool_step),
            Vec::<NormalizedEvent>::new()
        );

        let error = serde_json::json!({
            "type": "error",
            "error": {
                "data": {
                    "message": "rate limit"
                }
            }
        });
        assert_eq!(
            normalize_stream_event(&error),
            vec![
                NormalizedEvent::Error {
                    message: "rate limit".to_string(),
                    recoverable: false,
                },
                NormalizedEvent::TurnComplete {
                    reason: TurnEndReason::Error,
                    usage: None,
                },
            ]
        );
    }
}
