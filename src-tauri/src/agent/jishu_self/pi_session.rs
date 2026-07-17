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

pub(crate) fn persist_pi_interaction_blocks(
    session_id: &str,
    interactions: Vec<serde_json::Value>,
) -> Result<(), String> {
    let location = find_pi_session_location(session_id)?;
    persist_pi_interaction_blocks_at_path(&location.path, interactions)
}

fn interaction_sidecar_path(session_path: &Path) -> PathBuf {
    session_path.with_extension("jishu-interactions")
}

fn pi_interaction_key(value: &serde_json::Value) -> String {
    if let Some(request_id) = value
        .get("request_id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!("request:{request_id}");
    }
    format!(
        "legacy:{}\n{}\n{}",
        value
            .get("origin")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default(),
        value
            .get("prompt")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default(),
        value
            .get("answer")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default(),
    )
}

fn pi_interaction_tool_name(name: &str) -> bool {
    let normalized = name
        .rsplit(['/', ':'])
        .next()
        .unwrap_or(name)
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

fn pi_tool_call_prompt(item: &serde_json::Value) -> Option<&str> {
    let arguments = item.get("arguments").or_else(|| item.get("input"))?;
    ["question", "prompt", "title"]
        .into_iter()
        .find_map(|key| arguments.get(key).and_then(serde_json::Value::as_str))
}

fn add_pi_interaction_anchor(
    session_path: &Path,
    interaction: &mut serde_json::Value,
    existing: &[serde_json::Value],
) {
    let Some(object) = interaction.as_object_mut() else {
        return;
    };
    if object.contains_key("anchor_message_id") {
        return;
    }

    let prompt = object
        .get("prompt")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let claimed_tool_calls = existing
        .iter()
        .filter_map(|value| value.get("anchor_tool_call_id"))
        .filter_map(serde_json::Value::as_str)
        .collect::<std::collections::HashSet<_>>();
    let Ok(content) = fs::read_to_string(session_path) else {
        return;
    };
    let mut matching_anchor = None;

    'messages: for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if !matches!(
            value.get("type").and_then(serde_json::Value::as_str),
            Some("message") | Some("message_start") | Some("message_end")
        ) {
            continue;
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        if message.get("role").and_then(serde_json::Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(message_id) = value.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };

        let Some(items) = message.get("content").and_then(serde_json::Value::as_array) else {
            continue;
        };
        for item in items {
            let Some(name) = item.get("name").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let Some(tool_call_id) = item.get("id").and_then(serde_json::Value::as_str) else {
                continue;
            };
            if pi_interaction_tool_name(name)
                && !claimed_tool_calls.contains(tool_call_id)
                && pi_tool_call_prompt(item).map(str::trim) == Some(prompt)
            {
                matching_anchor = Some((message_id.to_string(), tool_call_id.to_string()));
                break 'messages;
            }
        }
    }

    if let Some((message_id, tool_call_id)) = matching_anchor {
        object.insert(
            "anchor_message_id".to_string(),
            serde_json::json!(message_id),
        );
        object.insert(
            "anchor_tool_call_id".to_string(),
            serde_json::json!(tool_call_id),
        );
    } else if let Some(message_id) = last_pi_assistant_message_id(&content) {
        object.insert(
            "anchor_message_id".to_string(),
            serde_json::json!(message_id),
        );
    }
}

fn last_pi_assistant_message_id(content: &str) -> Option<String> {
    content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|value| {
            matches!(
                value.get("type").and_then(serde_json::Value::as_str),
                Some("message") | Some("message_start") | Some("message_end")
            ) && value
                .get("message")
                .and_then(|message| message.get("role"))
                .and_then(serde_json::Value::as_str)
                == Some("assistant")
        })
        .filter_map(|value| {
            value
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .last()
}

fn persist_pi_interaction_blocks_at_path(
    session_path: &Path,
    interactions: Vec<serde_json::Value>,
) -> Result<(), String> {
    if !session_path.is_file()
        || session_path.extension().and_then(|value| value.to_str()) != Some("jsonl")
    {
        return Err("Pi interaction persistence requires an existing session JSONL".to_string());
    }

    let sidecar = interaction_sidecar_path(session_path);
    let mut entries = if sidecar.exists() {
        fs::read_to_string(&sidecar)
            .map_err(|error| format!("Failed to read Pi interaction sidecar: {error}"))?
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str::<serde_json::Value>(line)
                    .map_err(|error| format!("Invalid Pi interaction sidecar entry: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };

    for mut interaction in interactions {
        let key = pi_interaction_key(&interaction);
        if let Some(previous) = entries
            .iter()
            .find(|existing| pi_interaction_key(existing) == key)
        {
            if let (Some(object), Some(previous_object)) =
                (interaction.as_object_mut(), previous.as_object())
            {
                for field in ["anchor_message_id", "anchor_tool_call_id"] {
                    if !object.contains_key(field) {
                        if let Some(value) = previous_object.get(field) {
                            object.insert(field.to_string(), value.clone());
                        }
                    }
                }
            }
        }
        add_pi_interaction_anchor(session_path, &mut interaction, &entries);
        if let Some(object) = interaction.as_object_mut() {
            object.insert("type".to_string(), serde_json::json!("interaction"));
        }
        entries.retain(|existing| pi_interaction_key(existing) != key);
        entries.push(interaction);
    }

    let mut serialized = entries
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .join("\n");
    if !serialized.is_empty() {
        serialized.push('\n');
    }
    crate::util::atomic_write(&sidecar, serialized.as_bytes())
        .map_err(|error| format!("Failed to write Pi interaction sidecar: {error}"))
}

fn merge_pi_interaction_sidecar(session_path: &Path, messages: &mut Vec<crate::session::Message>) {
    let sidecar = interaction_sidecar_path(session_path);
    let Ok(content) = fs::read_to_string(&sidecar) else {
        return;
    };
    let session_content = fs::read_to_string(session_path).unwrap_or_default();
    let message_positions = pi_message_positions(&session_content);
    let mut replaced_tool_calls = std::collections::HashSet::new();
    let mut anchored_blocks: Vec<(usize, crate::session::ContentBlock)> = Vec::new();
    let mut fallback_blocks = Vec::new();

    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            log::warn!(
                "Ignoring invalid Pi interaction sidecar entry for {:?}",
                session_path
            );
            continue;
        };
        let Ok(block @ crate::session::ContentBlock::Interaction { .. }) =
            serde_json::from_value::<crate::session::ContentBlock>(value.clone())
        else {
            log::warn!(
                "Ignoring invalid Pi interaction sidecar entry for {:?}",
                session_path
            );
            continue;
        };

        let anchored_tool_call_id = value
            .get("anchor_tool_call_id")
            .and_then(serde_json::Value::as_str);
        let prompt = value
            .get("prompt")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let tool_call_id = anchored_tool_call_id
            .map(str::to_string)
            .or_else(|| find_pi_interaction_tool(messages, prompt, &replaced_tool_calls));

        if let Some(tool_call_id) = tool_call_id {
            if replace_pi_interaction_tool(messages, &tool_call_id, block.clone()) {
                replaced_tool_calls.insert(tool_call_id);
                continue;
            }
        }
        if let Some(message_index) = value
            .get("anchor_message_id")
            .and_then(serde_json::Value::as_str)
            .and_then(|message_id| message_positions.get(message_id))
            .copied()
        {
            anchored_blocks.push((message_index, block));
        } else {
            fallback_blocks.push(block);
        }
    }

    for (message_index, block) in anchored_blocks {
        if let Some(message) = messages.get_mut(message_index) {
            message.content.push(block);
        } else {
            fallback_blocks.push(block);
        }
    }

    if !replaced_tool_calls.is_empty() {
        for message in messages.iter_mut() {
            message.content.retain(|block| {
                !matches!(
                    block,
                    crate::session::ContentBlock::ToolResult { tool_use_id, .. }
                        if replaced_tool_calls.contains(tool_use_id)
                )
            });
        }
        messages.retain(|message| !message.content.is_empty());
    }
    if fallback_blocks.is_empty() {
        return;
    }

    if let Some(message) = messages
        .iter_mut()
        .rev()
        .find(|message| message.role == "assistant")
    {
        message.content.extend(fallback_blocks);
    } else {
        messages.push(crate::session::Message {
            role: "assistant".to_string(),
            content: fallback_blocks,
            timestamp: None,
        });
    }
}

fn pi_message_positions(content: &str) -> std::collections::HashMap<String, usize> {
    let mut positions = std::collections::HashMap::new();
    let mut message_index = 0;

    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if !matches!(
            value.get("type").and_then(serde_json::Value::as_str),
            Some("message") | Some("message_start") | Some("message_end")
        ) {
            continue;
        }
        let entry_timestamp = value
            .get("timestamp")
            .and_then(serde_json::Value::as_str)
            .and_then(parse_rfc3339_millis);
        let Some(message) = value
            .get("message")
            .and_then(|message| parse_pi_message(message, entry_timestamp))
        else {
            continue;
        };
        if let Some(id) = value.get("id").and_then(serde_json::Value::as_str) {
            positions.insert(id.to_string(), message_index);
        }
        let _ = message;
        message_index += 1;
    }

    positions
}

fn find_pi_interaction_tool(
    messages: &[crate::session::Message],
    prompt: &str,
    used: &std::collections::HashSet<String>,
) -> Option<String> {
    messages.iter().find_map(|message| {
        message.content.iter().find_map(|block| match block {
            crate::session::ContentBlock::ToolUse { id, name, input }
                if pi_interaction_tool_name(name)
                    && !used.contains(id)
                    && ["question", "prompt", "title"]
                        .into_iter()
                        .find_map(|key| input.get(key).and_then(serde_json::Value::as_str))
                        .map(str::trim)
                        == Some(prompt.trim()) =>
            {
                Some(id.clone())
            }
            _ => None,
        })
    })
}

fn replace_pi_interaction_tool(
    messages: &mut [crate::session::Message],
    tool_call_id: &str,
    interaction: crate::session::ContentBlock,
) -> bool {
    for message in messages {
        if let Some(index) = message.content.iter().position(|block| {
            matches!(
                block,
                crate::session::ContentBlock::ToolUse { id, .. } if id == tool_call_id
            )
        }) {
            message.content[index] = interaction;
            return true;
        }
    }
    false
}

pub(crate) fn load_pi_session(path: &Path) -> Option<crate::session::Session> {
    let content = fs::read_to_string(path).ok()?;
    let mut session = parse_pi_session_jsonl(path, &content)?;
    merge_pi_interaction_sidecar(path, &mut session.messages);
    Some(session)
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

/// Scan `~/.jishu-agent/sessions/` directories and return discovered projects.
/// Reads the `cwd` from session JSONL headers for reliable path decoding.
pub(crate) fn scan_pi_projects() -> Vec<crate::project::Project> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let sessions_root = pi_sessions_root_for_home(&home);
    if !sessions_root.is_dir() {
        return Vec::new();
    }

    let mut projects = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();

    let entries = match fs::read_dir(&sessions_root) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }

        // Read cwd from first JSONL session header — avoids encoding ambiguity
        let project_path = match read_cwd_from_session_dir(&dir) {
            Some(p) => p,
            None => continue,
        };

        if !Path::new(&project_path).is_dir() {
            continue;
        }
        if !seen_paths.insert(project_path.clone()) {
            continue;
        }

        let session_count = count_pi_sessions_in_dir(&dir);
        let last_active = last_modified_in_dir(&dir);

        if let Some(project) = crate::project::project_from_agent_path(
            &project_path,
            "jishu-self",
            session_count,
            last_active,
        ) {
            projects.push(project);
        }
    }

    projects.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    projects
}

/// Read the `cwd` field from the first JSONL session header in a directory.
fn read_cwd_from_session_dir(dir: &Path) -> Option<String> {
    for entry in fs::read_dir(dir).ok()? {
        let path = entry.ok()?.path();
        if path.extension().map(|ext| ext == "jsonl").unwrap_or(false) {
            if let Some(cwd) = read_cwd_from_jsonl(&path) {
                return Some(cwd);
            }
        }
    }
    None
}

/// Extract `cwd` from the `{"type":"session","cwd":"..."}` header line.
fn read_cwd_from_jsonl(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            if value.get("type").and_then(|v| v.as_str()) == Some("session") {
                if let Some(cwd) = value.get("cwd").and_then(|v| v.as_str()) {
                    let cwd = cwd.to_string();
                    if !cwd.is_empty() {
                        return Some(cwd);
                    }
                }
            }
        }
    }
    None
}

fn count_pi_sessions_in_dir(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path()
                        .extension()
                        .map(|ext| ext == "jsonl")
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

fn last_modified_in_dir(dir: &Path) -> Option<String> {
    fs::read_dir(dir).ok().and_then(|entries| {
        entries
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .extension()
                    .map(|ext| ext == "jsonl")
                    .unwrap_or(false)
            })
            .filter_map(|e| e.metadata().ok().and_then(|m| m.modified().ok()))
            .max()
            .map(|t| {
                let dt: DateTime<Utc> = t.into();
                dt.format("%Y-%m-%dT%H:%M:%S").to_string()
            })
    })
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
                r"C:\Users\tester\.jishu-agent\sessions\--D--MyCodes-unified-auth-system--"
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
    fn persists_pi_interactions_in_sidecar_with_latest_answer() {
        let root = std::env::temp_dir().join(format!(
            "jishu-pi-interaction-sidecar-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("sid-interaction.jsonl");
        let original = [
            r#"{"type":"session","version":3,"id":"sid-interaction","timestamp":"2026-06-01T00:00:00.000Z","cwd":"D:\\Work\\app"}"#,
            r#"{"type":"message_end","id":"a1","parentId":null,"timestamp":"2026-06-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"需求已明确"}],"stopReason":"stop","timestamp":1780272002000}}"#,
        ].join("\n");
        fs::write(&path, &original).unwrap();

        persist_pi_interaction_blocks_at_path(
            &path,
            vec![serde_json::json!({
                "request_id": "gate-1",
                "prompt": "是否进入规划？",
                "options": [],
                "answer": "继续补充需求",
                "selected_options": ["继续补充需求"],
                "origin": "extension_ui"
            })],
        )
        .unwrap();
        persist_pi_interaction_blocks_at_path(
            &path,
            vec![serde_json::json!({
                "request_id": "gate-1",
                "prompt": "是否进入规划？",
                "options": [],
                "answer": "进入流程规划",
                "selected_options": ["进入流程规划"],
                "origin": "extension_ui"
            })],
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let sidecar = fs::read_to_string(interaction_sidecar_path(&path)).unwrap();
        assert_eq!(sidecar.lines().count(), 1);
        assert!(sidecar.contains("进入流程规划"));
        assert!(!sidecar.contains("继续补充需求"));

        let session = load_pi_session(&path).unwrap();
        assert!(session
            .messages
            .iter()
            .any(|message| message.content.iter().any(|block| matches!(
                block,
                ContentBlock::Interaction { request_id, answer, .. }
                    if request_id.as_deref() == Some("gate-1") && answer == "进入流程规划"
            ))));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn keeps_non_tool_interaction_at_the_answered_assistant_message() {
        let root = std::env::temp_dir().join(format!(
            "jishu-pi-interaction-message-anchor-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("sid-gate-anchor.jsonl");
        let first_messages = [
            r#"{"type":"session","version":3,"id":"sid-gate-anchor","timestamp":"2026-07-16T10:20:32.000Z","cwd":"E:\\test"}"#,
            r#"{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"实现登录 demo"}]}}"#,
            r#"{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"候选需求已提交。"}]}}"#,
        ]
        .join("\n");
        fs::write(&path, &first_messages).unwrap();
        persist_pi_interaction_blocks_at_path(
            &path,
            vec![serde_json::json!({
                "request_id": "gate-1",
                "prompt": "是否进入规划？",
                "options": [],
                "answer": "进入流程规划",
                "origin": "extension_ui"
            })],
        )
        .unwrap();
        fs::write(
            &path,
            format!(
                "{first_messages}\n{}",
                r#"{"type":"message","id":"a2","message":{"role":"assistant","content":[{"type":"text","text":"开始流程规划。"}]}}"#
            ),
        )
        .unwrap();

        let session = load_pi_session(&path).unwrap();
        assert!(matches!(
            session.messages[1].content.as_slice(),
            [
                ContentBlock::Text { text },
                ContentBlock::Interaction { prompt, answer, .. }
            ] if text == "候选需求已提交。"
                && prompt == "是否进入规划？"
                && answer == "进入流程规划"
        ));
        assert!(matches!(
            session.messages[2].content.as_slice(),
            [ContentBlock::Text { text }] if text == "开始流程规划。"
        ));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn restores_legacy_pi_interactions_at_their_question_messages() {
        let root = std::env::temp_dir().join(format!(
            "jishu-pi-interaction-order-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("sid-interaction-order.jsonl");
        fs::write(
            &path,
            [
                r#"{"type":"session","version":3,"id":"sid-interaction-order","timestamp":"2026-07-16T10:20:32.000Z","cwd":"E:\\test"}"#,
                r#"{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"实现登录 demo"}]}}"#,
                r#"{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"先明确目标。"},{"type":"toolCall","id":"call-goal","name":"request_user_input","arguments":{"question":"主要目的是什么？"}}]}}"#,
                r#"{"type":"message","id":"t1","message":{"role":"toolResult","toolCallId":"call-goal","content":[{"type":"text","text":"单页面"}]}}"#,
                r#"{"type":"message","id":"a2","message":{"role":"assistant","content":[{"type":"text","text":"再明确技术栈。"},{"type":"toolCall","id":"call-stack","name":"request_user_input","arguments":{"question":"用什么技术栈？"}}]}}"#,
                r#"{"type":"message","id":"t2","message":{"role":"toolResult","toolCallId":"call-stack","content":[{"type":"text","text":"原生 HTML"}]}}"#,
                r#"{"type":"message","id":"a3","message":{"role":"assistant","content":[{"type":"text","text":"候选需求已提交。"}]}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            interaction_sidecar_path(&path),
            [
                r#"{"type":"interaction","request_id":"req-goal","prompt":"主要目的是什么？","options":[],"answer":"单页面","origin":"extension_ui"}"#,
                r#"{"type":"interaction","request_id":"req-stack","prompt":"用什么技术栈？","options":[],"answer":"原生 HTML","origin":"extension_ui"}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let session = load_pi_session(&path).unwrap();
        assert_eq!(session.messages.len(), 4);
        assert!(matches!(
            session.messages[1].content.as_slice(),
            [
                ContentBlock::Text { text },
                ContentBlock::Interaction { prompt, answer, .. }
            ] if text == "先明确目标。" && prompt == "主要目的是什么？" && answer == "单页面"
        ));
        assert!(matches!(
            session.messages[2].content.as_slice(),
            [
                ContentBlock::Text { text },
                ContentBlock::Interaction { prompt, answer, .. }
            ] if text == "再明确技术栈。" && prompt == "用什么技术栈？" && answer == "原生 HTML"
        ));
        assert!(matches!(
            session.messages[3].content.as_slice(),
            [ContentBlock::Text { text }] if text == "候选需求已提交。"
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
                .join("--D--My Codes-app--")
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
