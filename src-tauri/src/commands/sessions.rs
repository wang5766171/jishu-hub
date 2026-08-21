use std::collections::HashMap;
use std::sync::Mutex;

use crate::hub;
use crate::image;
use crate::session;
use crate::{with_app_state, AppState};

const TEXT_PREVIEW_MAX_BYTES: usize = 512 * 1024;

#[derive(serde::Serialize)]
pub(crate) struct TextFilePreview {
    path: String,
    content: String,
    truncated: bool,
    size: usize,
}

#[tauri::command]
pub(crate) async fn list_sessions(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    encoded_name: String,
) -> Result<Vec<session::Session>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .list_sessions(&encoded_name)
}

#[tauri::command]
pub(crate) async fn get_session_messages(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    session_id: String,
    encoded_name: String,
) -> Result<Vec<session::Message>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .get_session_messages(&session_id, &encoded_name)
}

/// Delete a native session through the agent's session adapter
/// (v0.7.4 需求1 B4). UI entry is capability-gated (SESSION_DELETE);
/// this returns the adapter's structured error for agents without it.
#[tauri::command]
pub(crate) async fn delete_agent_session(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    session_id: String,
    encoded_name: String,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .delete_session(&session_id, &encoded_name)
}

/// Persist interaction Q&A pairs through the agent's session adapter so
/// they survive app restarts without the IPC layer knowing the native store.
#[tauri::command]
pub(crate) async fn persist_interaction_blocks(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    session_path: String,
    session_id: Option<String>,
    encoded_name: Option<String>,
    interactions: Vec<serde_json::Value>,
) -> Result<(), String> {
    log::info!("persist_interaction_blocks called: agent={}, session_path='{}', session_id={:?}, encoded_name={:?}, count={}",
        agent_id, session_path, session_id, encoded_name, interactions.len());

    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .persist_interaction_blocks(
            (!session_path.trim().is_empty()).then_some(session_path.as_str()),
            session_id.as_deref(),
            encoded_name.as_deref(),
            interactions,
        )
}

/// Persist the in-progress assistant text/thinking of a CANCELLED turn so it
/// survives a session refresh. Claude-Code-specific: only its adapter actually
/// writes (others no-op — they persist incrementally in their own stores).
#[tauri::command]
pub(crate) async fn persist_partial_assistant(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    session_path: String,
    session_id: Option<String>,
    encoded_name: Option<String>,
    text: String,
    thinking: String,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .persist_partial_assistant(
            (!session_path.trim().is_empty()).then_some(session_path.as_str()),
            session_id.as_deref(),
            encoded_name.as_deref(),
            &text,
            &thinking,
        )
}

#[tauri::command]
pub(crate) async fn read_text_file(path: String) -> Result<TextFilePreview, String> {
    // Use the same path validation as the other read commands so all three
    // file-read entry points enforce identical rules (K-CRIT-1 consistency).
    image::validate_path(&std::path::PathBuf::from(&path))?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.iter().take(TEXT_PREVIEW_MAX_BYTES).any(|b| *b == 0) {
        return Err("Binary files cannot be previewed as text".to_string());
    }

    let size = bytes.len();
    let truncated = size > TEXT_PREVIEW_MAX_BYTES;
    let slice = if truncated {
        &bytes[..TEXT_PREVIEW_MAX_BYTES]
    } else {
        &bytes
    };
    let content = String::from_utf8_lossy(slice).to_string();

    Ok(TextFilePreview {
        path,
        content,
        truncated,
        size,
    })
}

#[tauri::command]
pub(crate) fn get_session_names() -> Result<HashMap<String, String>, String> {
    hub::get_session_names().map_err(|e| e.to_string())
}

/// 在系统文件管理器中定位文件（v0.8.0 需求4：文档预览「在资源管理器中显示」）。
#[tauri::command]
pub(crate) fn reveal_in_file_manager(path: String) -> Result<(), String> {
    crate::os_adapter::file_reveal::reveal_in_file_manager(&path)
}

/// 用系统关联应用打开文件本体（v0.8.0 需求4：文档预览「用关联应用打开」）。
#[tauri::command]
pub(crate) fn open_with_default_app(path: String) -> Result<(), String> {
    crate::os_adapter::file_reveal::open_with_default_app(&path)
}

#[tauri::command]
pub(crate) fn rename_session(session_id: String, name: String) -> Result<(), String> {
    hub::rename_session(session_id, name).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn delete_session_name(session_id: String) -> Result<(), String> {
    hub::delete_session_name(session_id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_text_file_preview() {
        let path =
            std::env::temp_dir().join(format!("jishu-hub-text-preview-{}.txt", std::process::id()));
        std::fs::write(&path, "line 1\nline 2").unwrap();

        let preview = tauri::async_runtime::block_on(super::read_text_file(
            path.to_string_lossy().to_string(),
        ))
        .unwrap();

        assert_eq!(preview.content, "line 1\nline 2");
        assert!(!preview.truncated);
        assert_eq!(preview.size, 13);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn inserts_interaction_blocks_into_last_assistant_jsonl_message() {
        let input = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"start"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Before"},{"type":"text","text":"After"}]}}"#;
        let interactions = vec![serde_json::json!({
            "index": 1,
            "prompt": "Choose implementation order",
            "options": [{"option_id": "backend", "label": "Backend first"}],
            "answer": "Backend first",
            "selected_options": ["backend"],
            "origin": "acp_elicitation"
        })];

        let output =
            crate::session::insert_interaction_blocks_into_jsonl(input, interactions).unwrap();
        let last_line = output.lines().last().unwrap();
        let value: serde_json::Value = serde_json::from_str(last_line).unwrap();
        let content = value["message"]["content"].as_array().unwrap();

        assert_eq!(content[0]["text"], "Before");
        assert_eq!(content[1]["type"], "interaction");
        assert_eq!(content[1]["prompt"], "Choose implementation order");
        assert_eq!(content[2]["text"], "After");
    }

    #[test]
    fn inserts_interaction_blocks_next_to_matching_tool_use_not_final_summary() {
        let input = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"start"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Intro"},{"type":"tool_use","id":"call_abc","name":"AskUserQuestion","input":{}}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Final summary"}]}}"#;
        let interactions = vec![serde_json::json!({
            "index": 99,
            "request_id": "call_abc:1",
            "prompt": "Choose implementation order",
            "options": [],
            "answer": "Backend first",
            "selected_options": ["backend"],
            "origin": "acp_elicitation"
        })];

        let output =
            crate::session::insert_interaction_blocks_into_jsonl(input, interactions).unwrap();
        let lines = output.lines().collect::<Vec<_>>();
        let first_assistant: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        let first_content = first_assistant["message"]["content"].as_array().unwrap();
        let final_assistant: serde_json::Value = serde_json::from_str(lines[2]).unwrap();
        let final_content = final_assistant["message"]["content"].as_array().unwrap();

        assert_eq!(first_content[0]["text"], "Intro");
        assert_eq!(first_content[1]["type"], "interaction");
        assert_eq!(first_content[1]["request_id"], "call_abc:1");
        assert_eq!(first_content[2]["type"], "tool_use");
        assert_eq!(final_content.len(), 1);
        assert_eq!(final_content[0]["text"], "Final summary");
    }

    #[test]
    fn moves_existing_interaction_only_tail_into_previous_assistant_and_dedupes() {
        let input = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"start"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Before"},{"type":"text","text":"After"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"interaction","prompt":"Choose implementation order","answer":"Backend first","options":[],"origin":"acp_elicitation"}]}}"#;
        let interactions = vec![serde_json::json!({
            "index": 1,
            "request_id": "17_0",
            "prompt": "Choose implementation order",
            "options": [],
            "answer": "Backend first",
            "selected_options": ["backend"],
            "origin": "acp_elicitation"
        })];

        let output =
            crate::session::insert_interaction_blocks_into_jsonl(input, interactions).unwrap();
        let lines = output.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);

        let value: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        let content = value["message"]["content"].as_array().unwrap();
        let interaction_count = content
            .iter()
            .filter(|block| block["type"] == "interaction")
            .count();

        assert_eq!(interaction_count, 1);
        assert_eq!(content[0]["text"], "Before");
        assert_eq!(content[1]["type"], "interaction");
        assert_eq!(content[1]["request_id"], "17_0");
        assert_eq!(content[2]["text"], "After");
    }

    #[test]
    fn dedupes_interaction_blocks_by_question_and_answer_when_request_ids_differ() {
        let input = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"start"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Before"},{"type":"text","text":"After"}]}}"#;
        let interactions = vec![
            serde_json::json!({
                "index": 1,
                "request_id": "0_1",
                "prompt": "Why did the hair stay dry?",
                "options": [],
                "answer": "Bald",
                "selected_options": ["Bald"],
                "origin": "acp_elicitation"
            }),
            serde_json::json!({
                "index": 1,
                "request_id": "duplicate_1",
                "prompt": "Why did the hair stay dry?",
                "options": [],
                "answer": "Bald",
                "selected_options": ["Bald"],
                "origin": "acp_elicitation"
            }),
        ];

        let output =
            crate::session::insert_interaction_blocks_into_jsonl(input, interactions).unwrap();
        let last_line = output.lines().last().unwrap();
        let value: serde_json::Value = serde_json::from_str(last_line).unwrap();
        let content = value["message"]["content"].as_array().unwrap();
        let interactions = content
            .iter()
            .filter(|block| block["type"] == "interaction")
            .collect::<Vec<_>>();

        assert_eq!(interactions.len(), 1);
        assert_eq!(interactions[0]["request_id"], "0_1");
        assert_eq!(interactions[0]["prompt"], "Why did the hair stay dry?");
    }
}
