use std::collections::HashMap;
use std::sync::Mutex;

use crate::hub;
use crate::image;
use crate::session;
use crate::AppState;

const TEXT_PREVIEW_MAX_BYTES: usize = 512 * 1024;

#[derive(serde::Serialize)]
pub(crate) struct TextFilePreview {
    path: String,
    content: String,
    truncated: bool,
    size: usize,
}

/// canonicalize 并剥 Windows verbatim 前缀（`\\?\C:\…` → `C:\…`、
/// `\\?\UNC\…` → `\\…`）——verbatim 形态会被 validate_path 误判 UNC 拒绝。
/// v0.9.7 需求6 F3：从 hub_invoke plugin_preview_html 抽出共用（原注释
/// 留痕：Windows canonicalize() 前缀问题系用户实测「UNC paths are not
/// allowed」教训）。
pub(crate) fn canonicalize_stripped(path: &std::path::Path) -> String {
    let s = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned();
    s.strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| s.strip_prefix(r"\\?\").map(|rest| rest.to_string()))
        .unwrap_or(s)
}

/// v0.9.7 需求6 F3：会话内产物引用的点击校验（P1-5：project_root 由前端
/// 显式传入——不依赖进程表反查，刷新/重启后回放链接依然可校验）。
/// 前缀限定 ∈ {project_root, project_root/.jishu-hub/tasks}（越界拒绝），
/// 大小上限（图片 10MB / 文本类 2MB），按扩展名返回面板渲染器类别。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PreviewFileKind {
    Html,
    Image,
    Markdown,
    Text,
    Unsupported,
}

const IMAGE_PREVIEW_MAX_BYTES: u64 = 10 * 1024 * 1024;
const ARTIFACT_TEXT_PREVIEW_MAX_BYTES: u64 = 2 * 1024 * 1024;

fn preview_kind_for_ext(ext: &str) -> PreviewFileKind {
    match ext {
        "html" | "htm" => PreviewFileKind::Html,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" => PreviewFileKind::Image,
        "md" => PreviewFileKind::Markdown,
        // 文本类与既有 text_file_preview 的口径对齐（image.rs mime 表同族）。
        "txt" | "log" | "json" | "xml" | "yaml" | "yml" | "toml" | "csv" | "ts" | "tsx" | "js"
        | "mjs" | "py" | "rs" | "go" | "java" | "c" | "h" | "cpp" | "cs" | "sh" => {
            PreviewFileKind::Text
        }
        _ => PreviewFileKind::Unsupported,
    }
}

/// v0.9.7 需求14：会话锁定模型读取（None=跟全局 active）。
#[tauri::command]
pub(crate) fn session_model_get(session_id: String) -> Result<Option<(String, String)>, String> {
    Ok(crate::session_models::get_session_model(&session_id))
}

/// v0.9.7 需求14：会话锁定模型设置（model 空=清除回落全局）。
#[tauri::command]
pub(crate) fn session_model_set(
    session_id: String,
    provider: String,
    model: String,
) -> Result<(), String> {
    crate::session_models::set_session_model(&session_id, &provider, &model)
}

#[tauri::command]
pub(crate) fn validate_preview_file(
    path: String,
    project_root: String,
    session_id: Option<String>,
) -> Result<PreviewFileKind, String> {
    let _ = session_id; // 预留：校验语义目前与会话无关（基准=project_root）
    let file = std::path::PathBuf::from(&path);
    // 错误串带机器前缀（前端契约：[not_found]/[out_of_scope]/[too_large]/
    // [unsupported]，前端按前缀优先匹配、回退中文子串；评审十八）。中文正文
    // 原样保留。
    if !file.is_file() {
        return Err(format!("[not_found] 文件不存在: {path}"));
    }
    let canonical_file = canonicalize_stripped(&file);
    // 基准目录：项目根 + 任务产物区（任务卡「打开」的产物在 .jishu-hub/tasks 下）。
    let root = std::path::PathBuf::from(&project_root);
    if !root.is_dir() {
        return Err(format!("项目目录不存在: {project_root}"));
    }
    let canonical_root = canonicalize_stripped(&root);
    let canonical_tasks = canonicalize_stripped(&root.join(".jishu-hub").join("tasks"));
    let in_bounds = [canonical_root, canonical_tasks].iter().any(|base| {
        let f = canonical_file.to_lowercase().replace('/', "\\");
        let b = base.to_lowercase().replace('/', "\\");
        f == b || f.starts_with(&format!("{b}\\"))
    });
    if !in_bounds {
        return Err(format!("[out_of_scope] 引用超出项目范围，已拦截: {path}"));
    }
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let kind = preview_kind_for_ext(&ext);
    let size = std::fs::metadata(&file).map_err(|e| e.to_string())?.len();
    let limit = match kind {
        PreviewFileKind::Image => IMAGE_PREVIEW_MAX_BYTES,
        PreviewFileKind::Html | PreviewFileKind::Markdown | PreviewFileKind::Text => {
            ARTIFACT_TEXT_PREVIEW_MAX_BYTES
        }
        // 不支持类型：大小不拦、返回 Ok(Unsupported)——面板按类别给
        // 「新窗口打开」按钮；[unsupported] 前缀留给未来出现的错误路径
        // （本命令当前对不支持类型不报错）。
        PreviewFileKind::Unsupported => u64::MAX,
    };
    if size > limit {
        return Err(format!(
            "[too_large] 文件过大：{size} 字节超过预览上限（{limit} 字节）"
        ));
    }
    Ok(kind)
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
                    let (clean, ids) = crate::agent::internal_prompts::extract_tool_snapshot(text);
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
        return Ok(format!(
            "toast(protocol) 已提交（AUMID={aumid}, launch={launch}）"
        ));
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
            let _ = handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
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
            });
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
fn show_protocol_toast(
    aumid: &str,
    title: &str,
    body: &str,
    launch: &str,
    sound: bool,
) -> Result<(), String> {
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
    notifier
        .Show(&toast)
        .map_err(|e| format!("Show failed: {e}"))
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
    use super::PreviewFileKind;

    /// v0.9.7 需求6 F3：引用校验——项目内按扩展名返回类别；越界（项目外
    /// /逃逸路径）拒绝；任务产物区放行。
    /// 第五轮评审 P2-6：项目目录扫描纯函数——剥包裹（路径自身尾部 '-'
    /// 不误剥）、无包裹目录/文件不收、排序稳定。
    #[test]
    fn scan_encoded_project_dirs_filters_and_strips() {
        let root = tempfile::tempdir().unwrap();
        for name in ["--D--foo---", "--B--bar--", "plain-dir", "--file--"] {
            let p = root.path().join(name);
            if name == "--file--" {
                std::fs::write(&p, b"x").unwrap(); // 文件不收（即便带包裹名）
            } else {
                std::fs::create_dir_all(&p).unwrap();
            }
        }
        let list = super::scan_encoded_project_dirs(root.path()).unwrap();
        assert_eq!(
            list,
            vec!["B--bar".to_string(), "D--foo-".to_string()],
            "只收包裹目录、精确剥包裹、按名排序"
        );
    }

    /// 第四轮评审 P2（根目录不存在返空）行为锚定——第五轮评审 P2-6 补用例。
    #[test]
    fn scan_encoded_project_dirs_missing_root_returns_empty() {
        let missing = std::env::temp_dir().join(format!("jishu-no-such-{}", uuid::Uuid::new_v4()));
        let list = super::scan_encoded_project_dirs(&missing).unwrap();
        assert!(list.is_empty(), "根目录不存在应返回空列表而非报错");
    }

    #[test]
    fn validate_preview_file_bounds_and_kind() {
        let root = std::env::temp_dir().join(format!("jishu-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::create_dir_all(root.join(".jishu-hub/tasks/t1/artifacts")).unwrap();
        std::fs::write(root.join("docs/design.html"), "<html></html>").unwrap();
        std::fs::write(root.join(".jishu-hub/tasks/t1/artifacts/out.md"), "# ok").unwrap();
        std::fs::write(root.join("docs/shot.png"), b"png").unwrap();

        let html = super::validate_preview_file(
            root.join("docs/design.html").to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
            None,
        )
        .unwrap();
        assert!(matches!(html, PreviewFileKind::Html));

        let md = super::validate_preview_file(
            root.join(".jishu-hub/tasks/t1/artifacts/out.md")
                .to_string_lossy()
                .into_owned(),
            root.to_string_lossy().into_owned(),
            None,
        )
        .unwrap();
        assert!(matches!(md, PreviewFileKind::Markdown));

        let png = super::validate_preview_file(
            root.join("docs/shot.png").to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
            None,
        )
        .unwrap();
        assert!(matches!(png, PreviewFileKind::Image));

        // 项目外文件：拒绝（评审十八：错误串带机器前缀 + 中文正文保留）。
        let outside =
            std::env::temp_dir().join(format!("jishu-preview-out-{}.html", uuid::Uuid::new_v4()));
        std::fs::write(&outside, "<html></html>").unwrap();
        let err = super::validate_preview_file(
            outside.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
            None,
        )
        .unwrap_err();
        assert!(err.starts_with("[out_of_scope]"), "unexpected: {err}");
        assert!(err.contains("超出项目范围"), "unexpected: {err}");

        // 不存在的文件：拒绝（[not_found] 前缀）。
        let err = super::validate_preview_file(
            root.join("docs/missing.html")
                .to_string_lossy()
                .into_owned(),
            root.to_string_lossy().into_owned(),
            None,
        )
        .unwrap_err();
        assert!(err.starts_with("[not_found]"), "unexpected: {err}");
        assert!(err.contains("文件不存在"), "unexpected: {err}");

        // 超大文本文件：拒绝（[too_large] 前缀，中文正文含「文件过大」回退子串）。
        let big = root.join("docs/big.md");
        let big_body = vec![b'a'; super::ARTIFACT_TEXT_PREVIEW_MAX_BYTES as usize + 1];
        std::fs::write(&big, big_body).unwrap();
        let err = super::validate_preview_file(
            big.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
            None,
        )
        .unwrap_err();
        assert!(err.starts_with("[too_large]"), "unexpected: {err}");
        assert!(err.contains("文件过大"), "unexpected: {err}");
        let _ = std::fs::remove_file(&big);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn exports_binary_file_roundtrip() {
        // v0.9.2 测试期（mermaid PNG 导出）：base64 解码落盘往返。
        let path =
            std::env::temp_dir().join(format!("jishu-hub-export-bin-{}.png", std::process::id()));
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
            std::env::temp_dir()
                .join("jishu-hub-export-bin-bad.png")
                .to_string_lossy()
                .into_owned(),
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
pub(crate) async fn session_generate_title(session_id: String) -> Result<Option<String>, String> {
    Ok(crate::agent::jishu_self::session_title::generate_and_persist(&session_id).await)
}

// ── 二十三轮（用户裁决 2026-11-15）：hub 级能力面——插件 ctx.hub 数据源 ──

/// 插件会话摘要（ctx.hub.listSessions 的返回行；跨会话/跨项目只读面）。
#[derive(serde::Serialize)]
pub(crate) struct HubPluginSession {
    pub id: String,
    pub title: String,
    pub agent_id: Option<String>,
    pub project_path: Option<String>,
    pub started_at: Option<String>,
    pub last_active: Option<String>,
    pub message_count: usize,
    /// usage.db 精确记账 join（无记录时 None——旧会话/未产生用量）。
    pub total_cost: Option<f64>,
    pub tool_calls: Option<u64>,
}

/// 第四轮评审 P2 + 第五轮评审 P2-6：项目目录扫描提为可测纯函数——
/// 根目录不存在（全新安装零会话）返空列表（只读展示面优雅降级）；其他
/// 读取错误仍 fail loud；只收带 `--` 包裹的目录，剥包裹走单源
/// strip_session_dir_wrap（此前与 lib.rs 各持一份裸拷贝——改一处漏一处
/// 是修复轮被抓 P1 的高危形态）。排序保证列表稳定。
fn scan_encoded_project_dirs(root: &std::path::Path) -> Result<Vec<String>, String> {
    let dir = match std::fs::read_dir(root) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut list: Vec<String> = dir
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter(|e| e.file_name().to_string_lossy().starts_with("--"))
        .map(|e| crate::strip_session_dir_wrap(&e.file_name().to_string_lossy()))
        .collect();
    list.sort();
    Ok(list)
}

/// 跨项目（或指定项目）会话列表——插件开放能力（二十三轮）。
/// 复用 pi 会话解析（list_pi_sessions）；标题合并 ai-title 与用户重命名；
/// usage.db 按会话 join 花销/工具调用。只读，无写面。
#[tauri::command]
pub(crate) async fn hub_plugin_sessions(
    project_encoded: Option<String>,
) -> Result<Vec<HubPluginSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let names = hub::get_session_names().unwrap_or_default();
        // 项目集：指定单项目；否则全扫 sessions root 下的项目目录。
        let encoded_list: Vec<String> = match &project_encoded {
            Some(one) => vec![one.clone()],
            None => scan_encoded_project_dirs(
                &crate::agent::jishu_self::pi_session::pi_sessions_root()?,
            )?,
        };
        let mut out = Vec::new();
        for encoded in encoded_list {
            // 第四轮评审 P2：单项目解析失败局部化——目录损坏/半删等只丢
            // 该项目并留痕，不拖垮整个跨项目列表（§16.1 局部化纪律）。
            let sessions = match crate::agent::jishu_self::pi_session::list_pi_sessions(&encoded) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("[hub] 跳过无法解析的项目目录 {encoded}: {e}");
                    continue;
                }
            };
            for s in sessions {
                // 第四轮评审 P2：usage join 用 get_optional——无记账记录返回
                // None（插件可区分「未记账」与「真零」），不再把缺记当零花。
                // 第五轮评审 P2-5：get_optional 现在上抛真实读错（仅查无此行
                // 折 None）——列表 join 场景局部化：warn 留痕后按未记账计，
                // 不拖垮跨项目列表（与单项目跳过同款 §16.1 纪律）。
                let usage = match crate::usage_store::get_optional(&s.id) {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!("[hub] usage 读取失败，按未记账计 session {}: {e}", s.id);
                        None
                    }
                };
                out.push(HubPluginSession {
                    title: names
                        .get(&s.id)
                        .cloned()
                        .or_else(|| s.display_name.clone())
                        .unwrap_or_else(|| s.id.clone()),
                    id: s.id,
                    agent_id: s.agent_id.clone(),
                    project_path: s.project_path.clone(),
                    started_at: s.started_at.map(|t| t.to_rfc3339()),
                    last_active: s.last_active.map(|t| t.to_rfc3339()),
                    message_count: s.messages.len(),
                    total_cost: usage.as_ref().map(|u| u.total_cost),
                    tool_calls: usage.as_ref().map(|u| u.tool_calls),
                });
            }
        }
        // 全局按最近活跃倒序（跨项目口径）。
        out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
        Ok(out)
    })
    .await
    .map_err(|e| format!("scan sessions failed: {e}"))?
}

/// 单会话精确用量（usage.db session_usage；ctx.hub.sessionStats 数据源）。
/// 第四轮评审 P2：无记录返回 None——修前薄注册 get 的全零口径使「无记账」
/// 与「真零」不可区分；get 本体语义不变（chat/mcp_server 老调用方零影响）。
#[tauri::command]
pub(crate) fn usage_session(
    session_id: String,
) -> Result<Option<crate::usage_store::SessionUsageRow>, String> {
    crate::usage_store::get_optional(&session_id)
}
