use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

fn serialize_pathbuf<S: serde::Serializer>(path: &PathBuf, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&path.to_string_lossy())
}

fn serialize_option_datetime<S: serde::Serializer>(
    dt: &Option<DateTime<Utc>>,
    s: S,
) -> Result<S::Ok, S::Error> {
    match dt {
        Some(d) => s.serialize_str(&d.to_rfc3339()),
        None => s.serialize_none(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractionOptionInfo {
    pub option_id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: serde_json::Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        #[serde(rename = "tool_use_id")]
        tool_use_id: String,
        content: serde_json::Value,
    },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
    #[serde(rename = "interaction")]
    Interaction {
        prompt: String,
        #[serde(default)]
        options: Vec<InteractionOptionInfo>,
        answer: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        selected_options: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: Vec<ContentBlock>,
    pub timestamp: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub id: String,
    #[serde(serialize_with = "serialize_pathbuf")]
    pub path: PathBuf,
    pub messages: Vec<Message>,
    #[serde(serialize_with = "serialize_option_datetime")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(serialize_with = "serialize_option_datetime")]
    pub last_active: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

/// Parse an ai-title line from JSONL, returns the aiTitle string if found
fn parse_ai_title(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? == "ai-title" {
        v.get("aiTitle")?.as_str().map(|s| s.to_string())
    } else {
        None
    }
}

/// Generate a smart summary from text: split by punctuation, take first sentence, max 50 chars
fn smart_summary(text: &str) -> String {
    let text = text.trim();
    if text.is_empty() {
        return String::new();
    }
    // Split by sentence-ending punctuation or newlines
    let first_sentence = text
        .split(&['。', '？', '！', '，', '\n', '.', '?', '!', ','][..])
        .next()
        .unwrap_or(text)
        .trim();
    if first_sentence.len() <= 50 {
        first_sentence.to_string()
    } else {
        // Find a natural break point near 50 chars
        let end = first_sentence
            .char_indices()
            .take_while(|(i, _)| *i < 50)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(50);
        format!("{}…", &first_sentence[..end])
    }
}

const CONVERSATION_TYPES: &[&str] = &["user", "assistant"];

/// Returns true when `tool_name` corresponds to an interaction tool whose
/// `tool_use` / `tool_result` blocks should be suppressed in the rendered
/// history (the interaction data is captured separately as an `Interaction`
/// ContentBlock).
fn is_interaction_tool_name(tool_name: &str) -> bool {
    let normalized = tool_name
        .rsplit(['/', ':'])
        .next()
        .unwrap_or(tool_name)
        .replace('-', "_")
        .to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "request_user_input"
            | "ask_user"
            | "ask_user_input"
            | "askuserquestion"
            | "ask_user_question"
            | "ask_question"
    )
}

fn parse_content_blocks(value: &serde_json::Value) -> Vec<ContentBlock> {
    match value {
        serde_json::Value::String(s) => {
            if s.trim().is_empty() {
                vec![]
            } else {
                vec![ContentBlock::Text { text: s.clone() }]
            }
        }
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|item| serde_json::from_value(item.clone()).ok())
            .collect(),
        _ => vec![],
    }
}

pub fn parse_message(line: &str) -> Option<Message> {
    if line.trim().is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line).ok()?;

    let role = v.get("type")?.as_str()?.to_string();

    if !CONVERSATION_TYPES.contains(&role.as_str()) {
        return None;
    }

    let content_value = v
        .get("message")
        .and_then(|m| m.get("content"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let content = parse_content_blocks(&content_value);

    if content.is_empty() {
        return None;
    }

    // Filter out tool_use blocks for interaction tools and their corresponding
    // tool_result blocks. The interaction data is persisted separately as
    // Interaction ContentBlocks, so the raw tool blocks are redundant and would
    // render as generic TOOL cards on reload.
    let interaction_tool_ids: std::collections::HashSet<String> = content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolUse { id, name, .. } if is_interaction_tool_name(name) => {
                Some(id.clone())
            }
            _ => None,
        })
        .collect();

    let filtered: Vec<ContentBlock> = content
        .into_iter()
        .filter(|b| match b {
            ContentBlock::ToolUse { name, .. } if is_interaction_tool_name(name) => false,
            ContentBlock::ToolResult { tool_use_id, .. }
                if interaction_tool_ids.contains(tool_use_id) =>
            {
                false
            }
            _ => true,
        })
        .collect();

    if filtered.is_empty() {
        return None;
    }

    let timestamp = v.get("timestamp").and_then(|t| t.as_i64());

    Some(Message {
        role,
        content: filtered,
        timestamp,
    })
}

fn merge_tool_results(messages: &mut Vec<Message>) {
    let mut i = 1;
    while i < messages.len() {
        let is_only_tool_results = messages[i].role == "user"
            && !messages[i].content.is_empty()
            && messages[i]
                .content
                .iter()
                .all(|b| matches!(b, ContentBlock::ToolResult { .. }));

        if is_only_tool_results && messages[i - 1].role == "assistant" {
            let blocks: Vec<ContentBlock> = messages[i].content.drain(..).collect();
            messages[i - 1].content.extend(blocks);
            messages.remove(i);
            continue;
        }
        i += 1;
    }
}

pub fn load_session(path: &Path) -> Option<Session> {
    load_session_with_filter(path, |_| false)
}

pub fn load_session_with_filter<F>(path: &Path, should_skip_record: F) -> Option<Session>
where
    F: Fn(&serde_json::Value) -> bool,
{
    let id = path.file_stem()?.to_string_lossy().to_string();
    let content = std::fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = content.lines().collect();

    let mut messages = Vec::new();
    let mut last_ai_title: Option<String> = None;
    let mut first_user_text: Option<String> = None;

    for line in &lines {
        if serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .as_ref()
            .map(|v| should_skip_record(v))
            .unwrap_or(false)
        {
            continue;
        }

        // Check for ai-title
        if let Some(title) = parse_ai_title(line) {
            last_ai_title = Some(title);
        }
        // Parse conversation messages
        if let Some(msg) = parse_message(line) {
            // Capture first user message text for smart summary fallback
            if msg.role == "user" && first_user_text.is_none() {
                for block in &msg.content {
                    if let ContentBlock::Text { text } = block {
                        if !text.trim().is_empty() {
                            first_user_text = Some(text.clone());
                            break;
                        }
                    }
                }
            }
            messages.push(msg);
        }
    }

    merge_tool_results(&mut messages);

    // Merge consecutive assistant messages
    let mut i = 1;
    while i < messages.len() {
        if messages[i].role == "assistant" && messages[i - 1].role == "assistant" {
            let blocks: Vec<ContentBlock> = messages[i].content.drain(..).collect();
            messages[i - 1].content.extend(blocks);
            messages.remove(i);
            continue;
        }
        i += 1;
    }

    // Remove orphaned tool_result blocks (e.g. from interaction tools whose
    // tool_use was filtered out in parse_message). An orphan is a tool_result
    // whose tool_use_id has no matching tool_use in the same message.
    for msg in &mut messages {
        let use_ids: std::collections::HashSet<String> = msg
            .content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolUse { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect();
        msg.content.retain(|b| match b {
            ContentBlock::ToolResult { tool_use_id, .. } => use_ids.contains(tool_use_id),
            _ => true,
        });
    }
    // Drop messages that became empty after orphan removal.
    messages.retain(|m| !m.content.is_empty());

    if messages.is_empty() {
        return None;
    }

    let started_at = messages
        .first()
        .and_then(|m| m.timestamp)
        .map(|ts| DateTime::from_timestamp_millis(ts).unwrap_or_default());

    let display_name = last_ai_title.or_else(|| first_user_text.map(|t| smart_summary(&t)));

    let project_path = path
        .parent()
        .and_then(|dir| dir.file_name())
        .map(|name| crate::project::decode_project_path(&name.to_string_lossy()));

    Some(Session {
        id,
        path: path.to_path_buf(),
        messages,
        started_at,
        display_name,
        last_active: None,
        project_path,
    })
}

pub fn list_sessions(project_dir: &Path) -> Vec<Session> {
    list_sessions_with_filter(project_dir, |_| false)
}

pub fn list_sessions_with_filter<F>(project_dir: &Path, should_skip_record: F) -> Vec<Session>
where
    F: Fn(&serde_json::Value) -> bool + Copy,
{
    let mut sessions_with_time: Vec<(Session, std::time::SystemTime)> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(project_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|ext| ext == "jsonl").unwrap_or(false) {
                let mtime = path
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                if let Some(mut session) = load_session_with_filter(&path, should_skip_record) {
                    session.last_active = mtime
                        .duration_since(std::time::SystemTime::UNIX_EPOCH)
                        .ok()
                        .map(|d| {
                            DateTime::from_timestamp_millis(d.as_millis() as i64)
                                .unwrap_or_default()
                        });
                    sessions_with_time.push((session, mtime));
                }
            }
        }
    }

    sessions_with_time.sort_by(|a, b| b.1.cmp(&a.1));
    sessions_with_time.into_iter().map(|(s, _)| s).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ai_title() {
        let line = r#"{"type":"ai-title","aiTitle":"Fix login bug","sessionId":"abc"}"#;
        assert_eq!(parse_ai_title(line), Some("Fix login bug".to_string()));
    }

    #[test]
    fn test_parse_ai_title_ignores_other() {
        let line = r#"{"type":"user","message":{"content":"hello"}}"#;
        assert_eq!(parse_ai_title(line), None);
    }

    #[test]
    fn test_smart_summary_short() {
        assert_eq!(smart_summary("Hello world"), "Hello world");
    }

    #[test]
    fn test_smart_summary_long() {
        let long = "This is a very long sentence that exceeds fifty characters by quite a bit more text here";
        let result = smart_summary(long);
        assert!(result.ends_with('…'));
        assert!(result.len() <= 55); // 50 + ellipsis
    }

    #[test]
    fn test_smart_summary_splits_on_punctuation() {
        assert_eq!(
            smart_summary("First sentence. Second one"),
            "First sentence"
        );
        assert_eq!(smart_summary("第一句。第二句"), "第一句");
    }

    #[test]
    fn test_parse_tool_use_message() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"call_123","name":"Read","input":{"file_path":"test.png"}}]}}"#;
        let msg = parse_message(line).unwrap();
        assert_eq!(msg.role, "assistant");
        assert_eq!(msg.content.len(), 1);
        match &msg.content[0] {
            ContentBlock::ToolUse { name, .. } => assert_eq!(name, "Read"),
            other => panic!("Expected ToolUse, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_tool_result_message() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_123","content":"file contents here"}]}}"#;
        let msg = parse_message(line).unwrap();
        assert_eq!(msg.role, "user");
        match &msg.content[0] {
            ContentBlock::ToolResult { content, .. } => {
                assert_eq!(content.as_str().unwrap(), "file contents here");
            }
            other => panic!("Expected ToolResult, got {:?}", other),
        }
    }

    #[test]
    fn test_is_interaction_tool_name() {
        assert!(is_interaction_tool_name("request_user_input"));
        assert!(is_interaction_tool_name("ask_user"));
        assert!(is_interaction_tool_name("ask_user_input"));
        assert!(is_interaction_tool_name("AskUserQuestion"));
        assert!(is_interaction_tool_name("ask-user-question"));
        assert!(!is_interaction_tool_name("Read"));
        assert!(!is_interaction_tool_name("Write"));
        assert!(!is_interaction_tool_name("bash"));
    }

    #[test]
    fn test_parse_message_filters_interaction_tool_blocks() {
        // An assistant message with a request_user_input tool_use and a text block
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"call_int_1","name":"request_user_input","input":{"question":"pick one"}},{"type":"text","text":"Continuing..."}]}}"#;
        let msg = parse_message(line).unwrap();
        // tool_use for request_user_input should be filtered out
        assert_eq!(msg.content.len(), 1);
        match &msg.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "Continuing..."),
            other => panic!("Expected Text, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_message_keeps_non_interaction_tools() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"call_r","name":"Read","input":{"file":"x"}},{"type":"tool_use","id":"call_int_2","name":"request_user_input","input":{}}]}}"#;
        let msg = parse_message(line).unwrap();
        // Only Read tool_use should remain
        assert_eq!(msg.content.len(), 1);
        match &msg.content[0] {
            ContentBlock::ToolUse { name, .. } => assert_eq!(name, "Read"),
            other => panic!("Expected ToolUse(Read), got {:?}", other),
        }
    }
}
