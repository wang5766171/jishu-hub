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
    let mut messages = s
        .registry
        .require_agent(&agent_id)?
        .get_session_messages(&session_id, &encoded_name)?;
    // v0.8.1 需求7 → v0.9.0 需求3 方案 C：剥注入块并派生 tool_ids 元数据
    // （pill 渲染数据源；集中一处，覆盖全部 adapter 的回放）。
    for message in &mut messages {
        if message.role == "user" {
            for block in &mut message.content {
                if let crate::session::ContentBlock::Text { text, tool_ids } = block {
                    let (clean, ids) = crate::agent::tool_plugin::extract_tool_snapshot(text);
                    *text = clean;
                    *tool_ids = ids;
                }
            }
        }
    }
    Ok(messages)
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

/// Persist one turn's messages through the agent's session adapter
/// (v0.8.1 需求1 M2). Frontend calls this on turn_complete for agents that
/// declare HUB_SESSION_PERSIST; builtin adapters no-op (their native store
/// is written by the CLI process itself).
#[tauri::command]
pub(crate) async fn persist_agent_turn(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    session_id: String,
    encoded_name: Option<String>,
    messages: Vec<crate::session::Message>,
) -> Result<(), String> {
    let encoded = encoded_name.unwrap_or_default();
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .persist_turn_messages(&session_id, &encoded, &messages)
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

/// v0.9.3 需求6：HTML 渲染卡「在新窗口打开」——内容写临时文件后经系统
/// 默认浏览器打开（沙箱 iframe 之外的完整交互能力）。临时文件名带纳秒
/// 时间戳防覆盖，路径回传仅供日志。
#[tauri::command]
pub(crate) fn open_html_external(html: String) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("jishu-hub-html-preview-{nanos}.html"));
    std::fs::write(&path, html).map_err(|e| format!("write temp html failed: {e}"))?;
    let path_str = path.to_string_lossy().to_string();
    crate::os_adapter::file_reveal::open_with_default_app(&path_str)?;
    Ok(path_str)
}

/// v0.9.3 测试期（通知排查 + 点击跳回 + 通知中心补点）：直接发桌面 toast，
/// **同步执行且错误如实返回**。
///
/// 点击跳回的完整链路（protocol 激活——弹窗点击与**通知中心补点**统一生效，
/// 后者不重发进程内 Activated 事件，只能经系统协议激活路由）：
/// toast XML `activationType="protocol" launch="jishu-hub://session/<id>"` →
/// Windows 按注册 scheme 启动/激活应用（deep-link 插件注册，single-instance
/// 插件把参数转发给运行中实例）→ lib.rs 解析 URL → 聚焦主窗 + 广播
/// `desktop-notify-click` → 前端插件经 ctx.switchSession 定位会话。
/// protocol toast 构造失败时回退 notify-rust（进程内激活，仅弹窗期点击有效）。
#[tauri::command]
pub(crate) fn desktop_notify_send(
    app: tauri::AppHandle,
    title: String,
    body: String,
    session_id: Option<String>,
    // v0.9.3 需求12 P1：提示音可配（None=响，兼容旧调用；Some(false)=静音）。
    sound: Option<bool>,
) -> Result<String, String> {
    use tauri::{Emitter, Manager};

    let identifier = app.config().identifier.clone();
    let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
    let dir = exe
        .parent()
        .ok_or("no exe dir")?
        .to_string_lossy()
        .to_string();
    let dev = dir.ends_with("\\target\\debug")
        || dir.ends_with("\\target\\release")
        || dir.ends_with("/target/debug")
        || dir.ends_with("/target/release");
    let aumid: &str = if dev {
        // dev 走 PowerShell AUMID（无应用快捷方式，自有 AUMID 的 toast 不显示）。
        "{1AC14E34-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"
    } else {
        identifier.as_str()
    };
    let launch = match &session_id {
        Some(sid) => format!("jishu-hub://session/{sid}"),
        // 无会话定位（任务失败通知）：点击仅打开/聚焦应用。
        None => "jishu-hub://open".to_string(),
    };

    // 首选 protocol toast：弹窗与通知中心点击统一走系统激活。
    if show_protocol_toast(aumid, &title, &body, &launch, sound.unwrap_or(true)).is_ok() {
        return Ok(format!("toast(protocol) 已提交（AUMID={aumid}, launch={launch}）"));
    }

    // 回退：notify-rust 普通通知 + 进程内 Activated（仅弹窗期点击有效，
    // wait_for_response 区分 Default 点击与关闭）。声音同款（Sound::from_str
    // 裸名 "Default" → Notification.Default）。
    let mut notification = notify_rust::Notification::new();
    notification.summary(&title).body(&body);
    if sound.unwrap_or(true) {
        notification.sound_name("Default");
    }
    notification.app_id(aumid);
    let handle = notification
        .show()
        .map_err(|e| format!("toast 发送失败：{e:?}"))?;
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = handle.wait_for_response(
                |response: &notify_rust::NotificationResponse| {
                    if response.is_default_action() {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit(
                            "desktop-notify-click",
                            serde_json::json!({ "sessionId": session_id }),
                        );
                    }
                },
            );
        });
    }
    Ok(format!("toast(fallback) 已提交（AUMID={aumid}）"))
}

/// XML 文本转义（toast 属性与文本节点）。
fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// 经 WinRT 直发 protocol 激活的 toast（`activationType="protocol"`）。
/// tauri-winrt-notification 封装不暴露 launch 属性，故此处手搓 XML——
/// 这是「通知中心补点也能激活应用」的唯一路径（进程内事件不覆盖补点）。
fn show_protocol_toast(aumid: &str, title: &str, body: &str, launch: &str, sound: bool) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    let audio_tag = if sound {
        "<audio src=\"ms-winsoundevent:Notification.Default\"/>"
    } else {
        "<audio silent=\"true\"/>"
    };
    let xml = format!(
        "<toast activationType=\"protocol\" launch=\"{}\" scenario=\"default\" duration=\"short\">\
         <visual><binding template=\"ToastGeneric\">\
         <text>{}</text><text>{}</text>\
         </binding></visual>\
         {}\
         </toast>",
        xml_escape(launch),
        xml_escape(title),
        xml_escape(body),
        audio_tag,
    );
    let doc = XmlDocument::new().map_err(|e| format!("XmlDocument failed: {e}"))?;
    doc.LoadXml(&HSTRING::from(xml.as_str()))
        .map_err(|e| format!("LoadXml failed: {e}"))?;
    let toast = ToastNotification::CreateToastNotification(&doc)
        .map_err(|e| format!("CreateToastNotification failed: {e}"))?;
    // windows 0.61：带 AUMID 的重载是 CreateToastNotifierWithId（无参版走
    // 当前应用的包标识，未打包应用必须用 Id 版指定 AUMID）。
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(aumid))
        .map_err(|e| format!("CreateToastNotifier failed: {e}"))?;
    notifier.Show(&toast).map_err(|e| format!("Show failed: {e}"))
}

#[tauri::command]
pub(crate) fn rename_session(session_id: String, name: String) -> Result<(), String> {
    hub::rename_session(session_id, name).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn delete_session_name(session_id: String) -> Result<(), String> {
    hub::delete_session_name(session_id).map_err(|e| e.to_string())
}

/// v0.9.2 需求1 M4：用量面板数据源（usage.db 权威记账的只读聚合）。
#[tauri::command]
pub(crate) fn usage_overview() -> Result<crate::usage_store::UsageOverview, String> {
    crate::usage_store::overview()
}

/// v0.9.2 需求1 M4：会话导出落盘（路径来自前端保存对话框；内容为 Markdown）。
#[tauri::command]
pub(crate) fn export_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("write export file failed: {e}"))
}

/// v0.9.2 测试期（mermaid 插件导出 PNG）：二进制导出落盘。前端把 Blob 编为
/// base64 传入，此处解码写盘——与 export_text_file 同一「保存对话框选路径 +
/// 命令落盘」模式。
#[tauri::command]
pub(crate) fn export_binary_file(path: String, base64_data: String) -> Result<(), String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("base64 decode failed: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("write export file failed: {e}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn exports_binary_file_roundtrip() {
        // v0.9.2 测试期（mermaid PNG 导出）：base64 解码落盘往返。
        let path = std::env::temp_dir().join(format!(
            "jishu-hub-export-bin-{}.png",
            std::process::id()
        ));
        let payload: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF];
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(payload);
        super::export_binary_file(path.to_string_lossy().into_owned(), b64).unwrap();
        let written = std::fs::read(&path).unwrap();
        assert_eq!(written, payload);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rejects_invalid_base64_export() {
        let err = super::export_binary_file(
            std::env::temp_dir().join("jishu-hub-export-bin-bad.png").to_string_lossy().into_owned(),
            "!!not-base64!!".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("base64"), "unexpected: {err}");
    }

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

/// v0.9.4 需求6 v2：为会话生成 AI 标题（LLM 一次性补全，结果以 pi 原生
/// session_info 条目落 JSONL）。幂等：已有命名（AI/用户重命名）返回 None；
/// 全程 fail-soft——失败静默（标题回落 smart_summary 规则截断），前端
/// 回合完成后触发一次。
#[tauri::command]
pub(crate) async fn session_generate_title(
    session_id: String,
) -> Result<Option<String>, String> {
    Ok(crate::agent::jishu_self::session_title::generate_and_persist(&session_id).await)
}
