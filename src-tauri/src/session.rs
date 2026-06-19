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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
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
            | "ask_choice"
            | "choice_question"
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

fn move_legacy_interaction_only_assistant_messages(messages: &mut Vec<Message>) {
    let mut i = 1;
    while i < messages.len() {
        if is_interaction_only_assistant_message(&messages[i])
            && messages[i - 1].role == "assistant"
            && !is_interaction_only_assistant_message(&messages[i - 1])
        {
            let target = i - 1;
            let message = messages.remove(i);
            messages.insert(target, message);
            i = target + 2;
            continue;
        }
        i += 1;
    }
}

fn is_interaction_only_assistant_message(message: &Message) -> bool {
    message.role == "assistant"
        && !message.content.is_empty()
        && message
            .content
            .iter()
            .all(|block| matches!(block, ContentBlock::Interaction { .. }))
}

fn dedupe_interaction_blocks(messages: &mut [Message]) {
    for message in messages {
        let mut seen = std::collections::HashSet::new();
        message.content.retain(|block| match block {
            ContentBlock::Interaction { .. } => seen.insert(interaction_block_key(block)),
            _ => true,
        });
    }
}

fn interaction_block_key(block: &ContentBlock) -> String {
    match block {
        ContentBlock::Interaction {
            request_id,
            prompt,
            answer,
            origin,
            ..
        } => {
            let semantic = format!(
                "{}\n{}\n{}",
                origin.clone().unwrap_or_default().trim(),
                prompt.trim(),
                answer.trim()
            );
            if prompt.trim().is_empty() && answer.trim().is_empty() {
                request_id.clone().unwrap_or(semantic)
            } else {
                semantic
            }
        }
        _ => String::new(),
    }
}

#[derive(Debug)]
struct InteractionBlockToInsert {
    index: usize,
    source_tool_id: Option<String>,
    prompt: String,
    identity_keys: Vec<String>,
    value: serde_json::Value,
}

pub fn persist_interaction_blocks_to_jsonl_path(
    path: &Path,
    interactions: Vec<serde_json::Value>,
) -> Result<(), String> {
    if !path.exists() {
        log::warn!("persist_interaction_blocks: path {:?} does not exist", path);
        return Ok(());
    }

    let mut last_err = None;
    for _ in 0..5 {
        wait_for_stable_file(path)?;
        let before = file_fingerprint(path)?;
        let original = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read session file: {e}"))?;
        let updated = insert_interaction_blocks_into_jsonl(&original, interactions.clone())?;
        let after = file_fingerprint(path)?;

        if before != after {
            last_err = Some("session file changed while preparing interaction persistence".to_string());
            std::thread::sleep(std::time::Duration::from_millis(50));
            continue;
        }

        return crate::util::atomic_write(path, updated.as_bytes())
            .map_err(|e| format!("Failed to write session file: {e}"));
    }

    Err(last_err.unwrap_or_else(|| "session file did not become stable".to_string()))
}

fn file_fingerprint(path: &Path) -> Result<(u64, Option<std::time::SystemTime>), String> {
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("Failed to stat session file: {e}"))?;
    Ok((metadata.len(), metadata.modified().ok()))
}

fn wait_for_stable_file(path: &Path) -> Result<(), String> {
    let mut previous = file_fingerprint(path)?;
    for _ in 0..10 {
        std::thread::sleep(std::time::Duration::from_millis(30));
        let current = file_fingerprint(path)?;
        if current == previous {
            return Ok(());
        }
        previous = current;
    }
    Err("session file is still changing".to_string())
}

pub(crate) fn insert_interaction_blocks_into_jsonl(
    input: &str,
    interactions: Vec<serde_json::Value>,
) -> Result<String, String> {
    let mut seen = std::collections::HashSet::new();
    let mut blocks = interactions
        .into_iter()
        .filter_map(|mut value| {
            let index = value
                .get("index")
                .and_then(serde_json::Value::as_u64)
                .map(|n| n as usize)
                .unwrap_or(usize::MAX);
            if let Some(obj) = value.as_object_mut() {
                obj.remove("index");
            }
            value["type"] = serde_json::json!("interaction");

            let identity_keys = interaction_identity_keys(&value);
            let primary_identity = identity_keys.first().cloned()?;
            if !seen.insert(primary_identity) {
                return None;
            }

            Some(InteractionBlockToInsert {
                index,
                source_tool_id: interaction_source_tool_id(&value),
                prompt: string_field(&value, "prompt"),
                identity_keys,
                value,
            })
        })
        .collect::<Vec<_>>();

    if blocks.is_empty() {
        return Ok(input.to_string());
    }
    blocks.sort_by_key(|block| block.index);

    let incoming_identities = blocks
        .iter()
        .flat_map(|block| block.identity_keys.iter().cloned())
        .collect::<std::collections::HashSet<_>>();

    let had_trailing_newline = input.ends_with('\n');
    let mut lines = input
        .lines()
        .map(|line| Some(line.to_string()))
        .collect::<Vec<_>>();

    remove_existing_interaction_blocks(&mut lines, &incoming_identities)?;

    let mut fallback_offsets: std::collections::HashMap<(usize, usize), usize> =
        std::collections::HashMap::new();
    for block in blocks {
        if let Some((line_index, position)) = find_tool_anchor(&lines, &block) {
            insert_interaction_block(&mut lines, line_index, position, block.value)?;
            continue;
        }

        if let Some(line_index) = find_last_assistant_with_visible_content(&lines) {
            let offset_key = (line_index, block.index);
            let offset = *fallback_offsets.get(&offset_key).unwrap_or(&0);
            insert_interaction_block(
                &mut lines,
                line_index,
                block.index.saturating_add(offset),
                block.value,
            )?;
            fallback_offsets.insert(offset_key, offset + 1);
            continue;
        }

        let value = serde_json::json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [block.value],
            }
        });
        lines.push(Some(
            serde_json::to_string(&value).map_err(|e| e.to_string())?,
        ));
    }

    let mut output = lines.into_iter().flatten().collect::<Vec<_>>().join("\n");
    if had_trailing_newline && !output.ends_with('\n') {
        output.push('\n');
    }
    Ok(output)
}

fn remove_existing_interaction_blocks(
    lines: &mut [Option<String>],
    incoming_identities: &std::collections::HashSet<String>,
) -> Result<(), String> {
    for line in lines.iter_mut() {
        let Some(raw_line) = line.as_ref() else {
            continue;
        };
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(raw_line) else {
            continue;
        };
        if value.get("type").and_then(serde_json::Value::as_str) != Some("assistant") {
            continue;
        }

        let Some(content_value) = value
            .get_mut("message")
            .and_then(|message| message.get_mut("content"))
        else {
            continue;
        };
        normalize_assistant_content(content_value);

        let Some(content) = content_value.as_array_mut() else {
            continue;
        };
        let was_interaction_only =
            !content.is_empty() && content.iter().all(is_interaction_json_block);
        content.retain(|block| {
            if !is_interaction_json_block(block) {
                return true;
            }
            let keys = interaction_identity_keys(block);
            !keys.iter().any(|key| incoming_identities.contains(key))
        });

        if was_interaction_only && content.is_empty() {
            *line = None;
        } else {
            *line = Some(serde_json::to_string(&value).map_err(|e| e.to_string())?);
        }
    }
    Ok(())
}

fn find_tool_anchor(
    lines: &[Option<String>],
    block: &InteractionBlockToInsert,
) -> Option<(usize, usize)> {
    for (line_index, line) in lines.iter().enumerate() {
        let Some(raw_line) = line.as_ref() else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(raw_line) else {
            continue;
        };
        if value.get("type").and_then(serde_json::Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(content) = value
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };

        if let Some(source_tool_id) = block.source_tool_id.as_deref() {
            if let Some(position) = content.iter().position(|item| {
                item.get("type").and_then(serde_json::Value::as_str) == Some("tool_use")
                    && item.get("id").and_then(serde_json::Value::as_str) == Some(source_tool_id)
            }) {
                return Some((line_index, position));
            }
        }

        if !block.prompt.trim().is_empty() {
            if let Some(position) = content
                .iter()
                .position(|item| tool_use_contains_prompt(item, &block.prompt))
            {
                return Some((line_index, position));
            }
        }
    }
    None
}

fn find_last_assistant_with_visible_content(lines: &[Option<String>]) -> Option<usize> {
    lines
        .iter()
        .enumerate()
        .rev()
        .find_map(|(line_index, line)| {
            let value = serde_json::from_str::<serde_json::Value>(line.as_ref()?).ok()?;
            if value.get("type").and_then(serde_json::Value::as_str) != Some("assistant") {
                return None;
            }
            let content = value
                .get("message")
                .and_then(|message| message.get("content"))?;
            if content.as_str().is_some_and(|text| !text.trim().is_empty()) {
                return Some(line_index);
            }
            let has_visible_content = content
                .as_array()?
                .iter()
                .any(|item| !is_interaction_json_block(item));
            has_visible_content.then_some(line_index)
        })
}

fn insert_interaction_block(
    lines: &mut [Option<String>],
    line_index: usize,
    position: usize,
    block: serde_json::Value,
) -> Result<(), String> {
    let line = lines
        .get_mut(line_index)
        .and_then(Option::as_mut)
        .ok_or_else(|| "assistant target line is missing".to_string())?;
    let mut value: serde_json::Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    let content_value = value
        .get_mut("message")
        .and_then(|message| message.get_mut("content"))
        .ok_or_else(|| "assistant message is missing content".to_string())?;
    normalize_assistant_content(content_value);
    let content = content_value
        .as_array_mut()
        .ok_or_else(|| "assistant message content is not an array".to_string())?;
    let pos = position.min(content.len());
    content.insert(pos, block);
    *line = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    Ok(())
}

fn normalize_assistant_content(content_value: &mut serde_json::Value) {
    if content_value.is_string() {
        let text = content_value.as_str().unwrap_or_default().to_string();
        *content_value = serde_json::json!([{ "type": "text", "text": text }]);
    }
}

fn is_interaction_json_block(value: &serde_json::Value) -> bool {
    value.get("type").and_then(serde_json::Value::as_str) == Some("interaction")
}

fn interaction_source_tool_id(value: &serde_json::Value) -> Option<String> {
    let request_id =
        string_field(value, "source_tool_id").if_empty_then(|| string_field(value, "request_id"));
    if request_id.is_empty() {
        return None;
    }
    if let Some((source, _)) = request_id.split_once(':') {
        return (!source.trim().is_empty()).then(|| source.to_string());
    }
    let origin = string_field(value, "origin");
    if origin == "acp_elicitation" {
        if let Some((source, suffix)) = request_id.rsplit_once('_') {
            if !source.trim().is_empty() && suffix.parse::<usize>().is_ok() {
                return Some(source.to_string());
            }
        }
    }
    Some(request_id)
}

trait EmptyStringExt {
    fn if_empty_then<F: FnOnce() -> String>(self, fallback: F) -> String;
}

impl EmptyStringExt for String {
    fn if_empty_then<F: FnOnce() -> String>(self, fallback: F) -> String {
        if self.is_empty() {
            fallback()
        } else {
            self
        }
    }
}

fn interaction_identity_keys(value: &serde_json::Value) -> Vec<String> {
    let mut keys = Vec::new();
    let prompt = string_field(value, "prompt");
    let answer = string_field(value, "answer");
    let origin = string_field(value, "origin");
    if !prompt.is_empty() || !answer.is_empty() {
        keys.push(format!("qa:{origin}\n{prompt}\n{answer}"));
    }

    let request_id = string_field(value, "request_id");
    if !request_id.is_empty() {
        keys.push(format!("request:{request_id}"));
    }

    if keys.is_empty() {
        keys.push(format!(
            "json:{}",
            serde_json::to_string(value).unwrap_or_default()
        ));
    }
    keys
}

fn string_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn tool_use_contains_prompt(value: &serde_json::Value, prompt: &str) -> bool {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("tool_use") {
        return false;
    }
    let Some(input) = value.get("input") else {
        return false;
    };
    prompt_matches_question(input, prompt)
        || input
            .get("questions")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|questions| {
                questions
                    .iter()
                    .any(|question| prompt_matches_question(question, prompt))
            })
}

fn prompt_matches_question(value: &serde_json::Value, prompt: &str) -> bool {
    ["question", "prompt", "header"].iter().any(|key| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            == Some(prompt.trim())
    })
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
    move_legacy_interaction_only_assistant_messages(&mut messages);

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
    dedupe_interaction_blocks(&mut messages);

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
        assert!(is_interaction_tool_name("ask_choice"));
        assert!(is_interaction_tool_name("choice-question"));
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

    #[test]
    fn load_session_moves_legacy_interaction_tail_before_final_assistant_and_dedupes() {
        let dir = std::env::temp_dir().join(format!(
            "jishu-session-legacy-interaction-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("legacy.jsonl");
        let jsonl = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"start"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Intro"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Final summary"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"interaction","request_id":"0_0","prompt":"Q1","answer":"A1","options":[],"origin":"acp_elicitation"},{"type":"interaction","request_id":"0_1","prompt":"Q2","answer":"A2","options":[],"origin":"acp_elicitation"},{"type":"interaction","request_id":"duplicate_1","prompt":"Q2","answer":"A2","options":[],"origin":"acp_elicitation"}]}}"#;
        std::fs::write(&path, jsonl).unwrap();

        let session = load_session(&path).unwrap();
        let assistant = session
            .messages
            .iter()
            .find(|message| message.role == "assistant")
            .unwrap();

        assert_eq!(assistant.content.len(), 4);
        match &assistant.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "Intro"),
            other => panic!("Expected intro text, got {:?}", other),
        }
        match &assistant.content[1] {
            ContentBlock::Interaction { prompt, answer, .. } => {
                assert_eq!(prompt, "Q1");
                assert_eq!(answer, "A1");
            }
            other => panic!("Expected Q1 interaction, got {:?}", other),
        }
        match &assistant.content[2] {
            ContentBlock::Interaction { prompt, answer, .. } => {
                assert_eq!(prompt, "Q2");
                assert_eq!(answer, "A2");
            }
            other => panic!("Expected Q2 interaction, got {:?}", other),
        }
        match &assistant.content[3] {
            ContentBlock::Text { text } => assert_eq!(text, "Final summary"),
            other => panic!("Expected final text, got {:?}", other),
        }

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn persists_interaction_blocks_through_session_jsonl_surface() {
        let dir = std::env::temp_dir().join(format!(
            "jishu-session-persist-interaction-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("persist.jsonl");
        let jsonl = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"start"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Before"},{"type":"tool_use","id":"call_1","name":"AskUserQuestion","input":{"question":"Question 1"}},{"type":"text","text":"After"}]}}"#;
        std::fs::write(&path, jsonl).unwrap();

        persist_interaction_blocks_to_jsonl_path(
            &path,
            vec![serde_json::json!({
                "index": 1,
                "request_id": "call_1:0",
                "prompt": "Question 1",
                "options": [],
                "answer": "A",
                "selected_options": ["A"],
                "origin": "acp_elicitation"
            })],
        )
        .unwrap();

        let session = load_session(&path).unwrap();
        let assistant = session
            .messages
            .iter()
            .find(|message| message.role == "assistant")
            .unwrap();

        assert!(matches!(
            &assistant.content[1],
            ContentBlock::Interaction { prompt, answer, .. }
                if prompt == "Question 1" && answer == "A"
        ));

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(dir);
    }
}
