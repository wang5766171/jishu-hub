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
    Text {
        text: String,
        /// v0.9.0 需求3 方案 C：本条用户消息关联的工具插件 id 快照（回放时
        /// 从注入块派生填充，见 tool_plugin::extract_tool_snapshot）。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_ids: Vec<String>,
    },
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
    #[serde(rename = "phase_divider")]
    PhaseDivider { phase: String, title: String },
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
    /// v0.7.0 需求一：该会话绑定的智能体 id。
    /// 历史会话无此值（不做数据迁移，Option 兜底）；新版会话由各 adapter 回填。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
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
                vec![ContentBlock::Text { text: s.clone(), tool_ids: Vec::new() }]
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

    let custom_type = v
        .get("message")
        .and_then(|m| m.get("customType"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    let content_value = v
        .get("message")
        .and_then(|m| m.get("content"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let content = parse_content_blocks(&content_value);

    // Filter out tool_use blocks for interaction tools and their corresponding
    // tool_result blocks.
    let interaction_tool_ids: std::collections::HashSet<String> = content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolUse { id, name, .. } if is_interaction_tool_name(name) => {
                Some(id.clone())
            }
            _ => None,
        })
        .collect();

    let mut filtered: Vec<ContentBlock> = content
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

    let is_phase_enter = custom_type.starts_with("jishu-conductor:phase-enter:");

    if filtered.is_empty() && !is_phase_enter {
        return None;
    }

    let is_launch_text = role == "user"
        && filtered.iter().any(|b| match b {
            ContentBlock::Text { text, .. } => text.trim_start().starts_with("/jishu-task "),
            _ => false,
        });

    if is_phase_enter || is_launch_text {
        let phase = if is_phase_enter {
            custom_type
                .strip_prefix("jishu-conductor:phase-enter:")
                .unwrap_or("discuss")
        } else {
            "discuss"
        };

        let title = match phase {
            "discuss" => "需求讨论",
            "plan" => "流程规划",
            "execute" => "流程执行",
            "done" => "已完成",
            other => other,
        };

        let has_divider = filtered.iter().any(|b| match b {
            ContentBlock::PhaseDivider { phase: p, .. } => p == phase,
            _ => false,
        });

        if !has_divider {
            filtered.insert(
                0,
                ContentBlock::PhaseDivider {
                    phase: phase.to_string(),
                    title: title.to_string(),
                },
            );
        }
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
            last_err =
                Some("session file changed while preparing interaction persistence".to_string());
            std::thread::sleep(std::time::Duration::from_millis(50));
            continue;
        }

        return crate::util::atomic_write(path, updated.as_bytes())
            .map_err(|e| format!("Failed to write session file: {e}"));
    }

    Err(last_err.unwrap_or_else(|| "session file did not become stable".to_string()))
}

/// Minimum overlap (in bytes) required to treat a persisted-text suffix as a
/// genuine dedup boundary rather than a coincidental short match. Genuine
/// overlaps are the prose of complete assistant messages Claude already wrote
/// — usually far larger than this — while a coincidental tail-of-prior-turn /
/// head-of-this-turn match is overwhelmingly short. Falling below this bar
/// means "no overlap": we append the whole streamed text, risking a tiny
/// duplicated fragment instead of (worse) dropping content.
const MIN_DEDUP_OVERLAP: usize = 16;

/// Persist the in-progress assistant text/thinking that the `claude` CLI did
/// NOT flush to its transcript when the user cancelled the turn (Claude-Code
/// specific: the transcript is owned by the external `claude` process, which
/// writes at message-completion boundaries and abandons an interrupted
/// message). Without this, refreshing the session loses the partial the user
/// already saw — the in-memory stream cache has it, but the JSONL does not.
///
/// Appends a synthesized `assistant` record carrying ONLY the unpersisted tail,
/// computed by stripping the longest suffix of the file's existing assistant
/// text/thinking that is also a prefix of the streamed text/thinking. This
/// keeps the write idempotent (a second call after the first finds everything
/// already present and writes nothing) and never duplicates complete messages
/// Claude already durably wrote mid-turn.
pub fn persist_partial_assistant_to_jsonl_path(
    path: &Path,
    text: &str,
    thinking: &str,
) -> Result<(), String> {
    if !path.exists() {
        log::warn!("persist_partial_assistant: path {:?} does not exist", path);
        return Ok(());
    }

    let streamed_text = text.trim_end();
    let streamed_thinking = thinking.trim_end();
    if streamed_text.is_empty() && streamed_thinking.is_empty() {
        return Ok(());
    }

    let mut last_err = None;
    for _ in 0..5 {
        wait_for_stable_file(path)?;
        let before = file_fingerprint(path)?;
        let original = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read session file: {e}"))?;
        let updated =
            append_unpersisted_assistant_tail(&original, streamed_text, streamed_thinking);
        let after = file_fingerprint(path)?;

        if before != after {
            last_err = Some(
                "session file changed while preparing partial assistant persistence".to_string(),
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
            continue;
        }

        // Nothing new to persist (Claude already wrote it all, or this call is
        // a repeat) — skip the write entirely so we never touch the file.
        if updated == original {
            return Ok(());
        }

        return crate::util::atomic_write(path, updated.as_bytes())
            .map_err(|e| format!("Failed to write session file: {e}"));
    }

    Err(last_err.unwrap_or_else(|| "session file did not become stable".to_string()))
}

/// Build the updated JSONL by appending a single `assistant` record that holds
/// only the streamed text/thinking not already present in the file. Returns the
/// input unchanged when there is nothing new to write.
fn append_unpersisted_assistant_tail(
    input: &str,
    streamed_text: &str,
    streamed_thinking: &str,
) -> String {
    let (persisted_text, persisted_thinking) = collect_persisted_assistant_text(input);
    let new_text = unpersisted_suffix(&persisted_text, streamed_text);
    let new_thinking = unpersisted_suffix(&persisted_thinking, streamed_thinking);

    if new_text.is_empty() && new_thinking.is_empty() {
        return input.to_string();
    }

    // Mirror the record shape claude-agent-acp / the interaction-block
    // fallback already write (session.rs insert_interaction_blocks_into_jsonl
    // fallback branch): a `type:"assistant"` line whose `message.content` is a
    // block array. Thinking precedes text (matching the model's own ordering),
    // so load_session_with_filter renders them in the natural order.
    let mut content = Vec::<serde_json::Value>::new();
    if !new_thinking.is_empty() {
        content.push(serde_json::json!({ "type": "thinking", "thinking": new_thinking }));
    }
    if !new_text.is_empty() {
        content.push(serde_json::json!({ "type": "text", "text": new_text }));
    }

    let record = serde_json::json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": content,
        }
    });

    let mut output = if input.is_empty() {
        String::new()
    } else {
        // Preserve the existing trailing-newline convention.
        let mut s = input.to_string();
        if !s.ends_with('\n') {
            s.push('\n');
        }
        s
    };
    output.push_str(&record.to_string());
    output.push('\n');
    output
}

/// Concatenate every `text` block (and separately every `thinking` block) from
/// all `assistant`-typed records in the JSONL, in file order. This is the
/// assistant prose Claude has durably persisted across the whole conversation.
fn collect_persisted_assistant_text(input: &str) -> (String, String) {
    let mut text = String::new();
    let mut thinking = String::new();
    for line in input.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let Some(content) = value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for block in content {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                        text.push_str(t);
                    }
                }
                Some("thinking") => {
                    if let Some(t) = block.get("thinking").and_then(|v| v.as_str()) {
                        thinking.push_str(t);
                    }
                }
                _ => {}
            }
        }
    }
    (text, thinking)
}

/// Return the suffix of `streamed` that is NOT already covered by `persisted`.
///
/// Within a turn the streamed prose grows monotonically and Claude persists
/// complete messages in order, so the persisted region's tail overlaps a prefix
/// of `streamed`. We strip the longest such overlap. A coincidental short
/// match (prior turn ending with the same few bytes this turn starts with) is
/// rejected via `MIN_DEDUP_OVERLAP` so we never drop real content on a false
/// positive — the cost of under-detecting is a tiny duplicated fragment, while
/// over-detecting would lose content (the bug we are fixing).
fn unpersisted_suffix(persisted: &str, streamed: &str) -> String {
    if streamed.is_empty() {
        return String::new();
    }

    // Full overlap: the ENTIRE streamed text is already a suffix of what's
    // persisted (Claude flushed the whole message, or this is a repeat persist
    // call from the racing turn_complete / onAbort paths). The remainder is
    // empty, so this never drops content — recognize it regardless of length
    // so short turns stay idempotent.
    if persisted.ends_with(streamed) {
        return String::new();
    }

    // Partial overlap: a PREFIX of streamed coincides with a SUFFIX of
    // persisted (the in-progress tail continues from Claude's last complete
    // message). Require MIN_DEDUP_OVERLAP so a coincidental short match
    // (prior turn's tail vs this turn's head) is treated as "no overlap" and
    // we append the whole text rather than risk dropping real content.
    let mut offsets: Vec<usize> = streamed.char_indices().map(|(i, _)| i).collect();
    offsets.push(streamed.len());
    for &idx in offsets.iter().rev() {
        if idx < MIN_DEDUP_OVERLAP {
            break;
        }
        if idx == streamed.len() {
            continue; // full overlap already handled above
        }
        if persisted.ends_with(&streamed[..idx]) {
            return streamed[idx..].to_string();
        }
    }
    streamed.to_string()
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
        if let Some(mut msg) = parse_message(line) {
            // v0.8.1 需求7/10 → v0.9.0 需求3 方案 C：用户消息剥工具插件注入块
            // 并从块内 `## id — desc` 头派生 tool_ids 元数据（pill 渲染数据源）。
            if msg.role == "user" {
                for block in &mut msg.content {
                    if let ContentBlock::Text { text, tool_ids } = block {
                        let (clean, ids) = crate::agent::tool_plugin::extract_tool_snapshot(text);
                        *text = clean;
                        *tool_ids = ids;
                    }
                }
            }
            // Capture first user message text for smart summary fallback
            if msg.role == "user" && first_user_text.is_none() {
                for block in &msg.content {
                    if let ContentBlock::Text { text, .. } = block {
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

    // v0.8.1 需求10 → v0.9.0 需求3：会话列表名清洗注入块（文本标记已废弃）——
    // 标题必须呈现用户真实问题，不得泄漏插件注入块（§16.3 剥离契约）。
    let display_name = last_ai_title
        .map(|t| crate::agent::tool_plugin::strip_tool_block(&t))
        .or_else(|| first_user_text.map(|t| smart_summary(&crate::agent::tool_plugin::strip_tool_block(&t))));

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
        agent_id: None,
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
            ContentBlock::Text { text, .. } => assert_eq!(text, "Continuing..."),
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
            ContentBlock::Text { text, .. } => assert_eq!(text, "Intro"),
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
            ContentBlock::Text { text, .. } => assert_eq!(text, "Final summary"),
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

    // ── persist_partial_assistant: Claude-Code cancelled-turn tail recovery ──

    #[test]
    fn unpersisted_suffix_returns_full_when_no_overlap() {
        // Claude persisted nothing for this turn (e.g. user cancelled during
        // the very first streamed response) — the whole streamed text is new.
        assert_eq!(
            unpersisted_suffix("", "Hello world, this is partial"),
            "Hello world, this is partial"
        );
        assert_eq!(
            unpersisted_suffix(
                "a completely different prior turn",
                "Hello world, this is partial"
            ),
            "Hello world, this is partial"
        );
    }

    #[test]
    fn unpersisted_suffix_strips_genuine_overlap_prefix() {
        // Agentic turn: Claude durably wrote a complete message ("Let me read
        // the file."), then the model streamed more before being cancelled.
        let persisted = "Let me read the file.";
        let streamed = "Let me read the file. Now I will edit it and the answer is 42";
        assert_eq!(
            unpersisted_suffix(persisted, streamed),
            " Now I will edit it and the answer is 42"
        );
    }

    #[test]
    fn unpersisted_suffix_empty_when_already_persisted() {
        // Late cancel after Claude flushed the whole message → nothing new.
        let persisted = "The complete answer is here.";
        assert_eq!(unpersisted_suffix(persisted, persisted), "");
        assert_eq!(
            unpersisted_suffix(persisted, "The complete answer is here."),
            ""
        );
    }

    #[test]
    fn unpersisted_suffix_ignores_short_coincidental_match() {
        // Prior turn ends with "x." (2 bytes < MIN_DEDUP_OVERLAP). Even though
        // this turn's streamed text happens to start with "x.", the overlap is
        // too short to trust as a real boundary → treat as no overlap so we do
        // NOT drop content. (Cost: a tiny duplicated fragment, never data loss.)
        assert_eq!(
            unpersisted_suffix("...ending in x.", "x. brand new content"),
            "x. brand new content"
        );
    }

    #[test]
    fn unpersisted_suffix_is_utf8_safe_for_chinese() {
        // Must slice on a codepoint boundary, not mid-中. Genuine long overlap.
        let persisted = "我先读取了这个文件的内容。";
        let streamed = "我先读取了这个文件的内容。然后开始修改它，答案是四十二";
        assert_eq!(
            unpersisted_suffix(persisted, streamed),
            "然后开始修改它，答案是四十二"
        );
    }

    #[test]
    fn persist_partial_assistant_appends_full_text_when_nothing_persisted() {
        let dir =
            std::env::temp_dir().join(format!("jishu-session-partial-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("partial.jsonl");
        // Only a user message — Claude wrote no assistant record before cancel.
        let jsonl =
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#;
        std::fs::write(&path, jsonl).unwrap();

        persist_partial_assistant_to_jsonl_path(&path, "the partial streamed reply", "").unwrap();

        let session = load_session(&path).unwrap();
        let assistant = session
            .messages
            .iter()
            .find(|m| m.role == "assistant")
            .unwrap();
        match &assistant.content[0] {
            ContentBlock::Text { text, .. } => assert_eq!(text, "the partial streamed reply"),
            other => panic!("Expected text, got {:?}", other),
        }

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn persist_partial_assistant_is_idempotent() {
        let dir =
            std::env::temp_dir().join(format!("jishu-session-partial-idem-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("partial_idem.jsonl");
        std::fs::write(
            &path,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        )
        .unwrap();

        persist_partial_assistant_to_jsonl_path(&path, "partial reply", "").unwrap();
        let after_first = std::fs::read_to_string(&path).unwrap();
        // Second call (e.g. the abort callback racing turn_complete) must be a
        // no-op — the text is already present, so the file must not change.
        persist_partial_assistant_to_jsonl_path(&path, "partial reply", "").unwrap();
        let after_second = std::fs::read_to_string(&path).unwrap();
        assert_eq!(after_first, after_second);

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn persist_partial_assistant_appends_only_suffix_after_complete_message() {
        let dir = std::env::temp_dir().join(format!(
            "jishu-session-partial-suffix-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("partial_suffix.jsonl");
        // Agentic turn: Claude durably wrote a complete assistant message
        // (text + tool_use + result), then the model streamed more text and
        // the user cancelled. The persisted tail must NOT duplicate the
        // already-written complete message.
        let jsonl = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"do it"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me read the file."},{"type":"tool_use","id":"call_1","name":"Read","input":{"file_path":"x"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"x contents"}]}}"#;
        std::fs::write(&path, jsonl).unwrap();

        // Frontend accumulated the whole turn: complete message + in-progress tail.
        persist_partial_assistant_to_jsonl_path(
            &path,
            "Let me read the file. Now I will edit it and the answer is 42",
            "",
        )
        .unwrap();

        let session = load_session(&path).unwrap();
        // Merge-consecutive-assistant collapses the two assistant lines; the
        // rendered text must contain the complete message exactly once and the
        // new tail exactly once — no duplication of "Let me read the file.".
        let all_text: String = session
            .messages
            .iter()
            .filter(|m| m.role == "assistant")
            .flat_map(|m| m.content.iter())
            .filter_map(|b| match b {
                ContentBlock::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("");
        assert_eq!(
            all_text,
            "Let me read the file. Now I will edit it and the answer is 42"
        );

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn persist_partial_assistant_handles_thinking_separately() {
        let dir = std::env::temp_dir().join(format!(
            "jishu-session-partial-thinking-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("partial_thinking.jsonl");
        std::fs::write(
            &path,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        )
        .unwrap();

        persist_partial_assistant_to_jsonl_path(&path, "visible answer", "private reasoning")
            .unwrap();

        let session = load_session(&path).unwrap();
        let assistant = session
            .messages
            .iter()
            .find(|m| m.role == "assistant")
            .unwrap();
        let mut has_thinking = false;
        let mut has_text = false;
        for block in &assistant.content {
            match block {
                ContentBlock::Thinking { thinking } => {
                    assert_eq!(thinking, "private reasoning");
                    has_thinking = true;
                }
                ContentBlock::Text { text, .. } => {
                    assert_eq!(text, "visible answer");
                    has_text = true;
                }
                _ => {}
            }
        }
        assert!(has_thinking, "thinking block should be persisted");
        assert!(has_text, "text block should be persisted");

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(dir);
    }
}
