//! 会话 AI 标题生成（v0.9.4 需求6 v2：LLM 生成，pi 原生 session_info 通道）。
//!
//! 背景：hub 会话列表标题此前走 smart_summary 首条消息规则截断（分句符
//! 修正见 session.rs），用户要求真正的 AI 生成标题。pi 无 ai-title 生成
//! 功能，但 pi 原生会话命名机制可用：session JSONL 追加
//! `{"type":"session_info","name":...}` 条目——`SessionManager::
//! getSessionName` 取最新一条、hub pi_session.rs 回放解析同名条目为
//! display_name（:736-743 已存在）、TUI 亦识别。
//!
//! 链路：回合完成后前端触发 `session_generate_title`（幂等：已有
//! session_info 即跳过，用户重命名不被覆盖）→ 取首条用户消息 + 会话最近
//! 使用的 provider/model（JSONL assistant 行自带）→ models.json 解析为
//! ModelPreset（to_test_preset）→ 一次极小补全（max_tokens 64）→ 清洗后
//! 追加 session_info 行。全程 fail-soft：任何失败静默跳过（标题回落规则
//! 截断），绝不打扰会话。
//!
//! 并发：追加发生在回合结束后（pi 空闲期），单行 append 与 pi 自身追加
//! 同为行级写，安全。

use std::io::Write;
use std::path::PathBuf;

/// 生成并持久化会话标题；返回生成的标题（跳过/失败返回 None）。
pub async fn generate_and_persist(session_id: &str) -> Option<String> {
    // 1. 定位会话文件（sessions/<encoded-project>/<id>.jsonl；session id
    //    全局唯一，扫全部项目目录）。
    let path = find_session_file(session_id)?;
    let content = std::fs::read_to_string(&path).ok()?;
    let lines: Vec<&str> = content.lines().collect();

    // 2. 已有命名（AI 生成或用户重命名）→ 不覆盖。
    if has_session_info(&lines) {
        return None;
    }
    // 3. 首条用户消息（标题素材；剥插件注入块）。
    let first_user = first_user_text_from_lines(&lines)?;
    let snippet: String = first_user.chars().take(400).collect();

    // 4. 会话最近使用的 provider/model（assistant 行自带；比 active 更准
    //    ——该模型刚在本会话验证可用）。
    let (provider_id, model_id) = last_model_from_lines(&lines)?;

    // 5. 解析为 ModelPreset 并发起一次性补全。
    let config = crate::agent::jishu_self::pi_models_config::load().ok()?;
    let provider_cfg = config.providers.get(&provider_id)?.clone();
    let model = provider_cfg
        .models
        .as_ref()?
        .iter()
        .find(|m| m.id == model_id)?
        .clone();
    let preset =
        crate::agent::jishu_self::pi_models_config::to_test_preset(&provider_id, &provider_cfg, &model)
            .ok()?;
    crate::llm::http::resolve_api_key(&preset).ok()?;
    let provider = crate::llm::create_provider(&preset).ok()?;

    let req = crate::llm::message::LlmRequest {
        model: preset.model.clone(),
        messages: vec![crate::llm::message::LlmMessage {
            role: crate::llm::message::LlmRole::User,
            content: Some(format!(
                "根据下面的用户消息生成一个简短的会话标题，不超过16个字，准确概括任务主题。\
                 只输出标题本身：不要引号、不要句末标点、不要任何解释。\n\n用户消息：{snippet}"
            )),
            tool_calls: None,
            tool_call_id: None,
        }],
        tools: vec![],
        stream: true,
        max_tokens: Some(64),
        temperature: Some(0.0),
    };

    let response = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let resp_clone = response.clone();
    let mut emitter = Box::new(move |event| {
        if let crate::agent::NormalizedEvent::TextDelta { delta } = event {
            if let Ok(mut s) = resp_clone.lock() {
                s.push_str(&delta);
            }
        }
    });

    let cancel = crate::llm::CancelToken::new();
    let turn = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        provider.stream_chat(req, emitter, &cancel),
    )
    .await
    .ok()?
    .ok()?;

    let _ = turn; // 文本经 emitter 收集
    let raw = response.lock().ok()?.clone();
    let title = sanitize_title(&raw)?;

    // 6. 追加 session_info 行（pi 原生形状：id/parentId/timestamp/name）。
    append_session_info(&path, &title).ok()?;
    log::info!(
        "[session-title] generated for {session_id}: {title} ({} chars)",
        title.chars().count()
    );
    Some(title)
}

/// sessions 根目录下扫全部项目目录定位 `<session_id>.jsonl`。
fn find_session_file(session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || session_id.contains(['/', '\\'])
        || session_id.contains("..")
    {
        return None; // 纯 id，防路径逃逸
    }
    let root = crate::agent::jishu_self::pi_session::pi_sessions_root().ok()?;
    let entries = std::fs::read_dir(&root).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(format!("{session_id}.jsonl"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// 已存在 session_info 条目（AI 生成或用户重命名）→ 跳过。
fn has_session_info(lines: &[&str]) -> bool {
    lines.iter().any(|l| {
        serde_json::from_str::<serde_json::Value>(l)
            .ok()
            .and_then(|v| {
                (v.get("type")?.as_str()? == "session_info"
                    && v.get("name").and_then(|n| n.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false))
                    .then_some(())
            })
            .is_some()
    })
}

/// 首条用户消息文本（剥工具插件注入块；跳过空文本）。
fn first_user_text_from_lines(lines: &[&str]) -> Option<String> {
    for line in lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let msg = v.get("message")?;
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        if let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) {
            for block in blocks {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    let (clean, _ids) = crate::agent::tool_plugin::extract_tool_snapshot(text);
                    if !clean.trim().is_empty() {
                        return Some(clean.trim().to_string());
                    }
                }
            }
        }
    }
    None
}

/// 最近一条带 provider/model 的 assistant 消息 → (provider, model)。
fn last_model_from_lines(lines: &[&str]) -> Option<(String, String)> {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let msg = v.get("message")?;
        if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            continue;
        }
        let provider = msg.get("provider").and_then(|p| p.as_str())?;
        let model = msg.get("model").and_then(|m| m.as_str())?;
        if !provider.is_empty() && !model.is_empty() {
            return Some((provider.to_string(), model.to_string()));
        }
    }
    None
}

/// 标题清洗：剥引号包裹/句末标点，换行折叠空白，上限 60 字符，空 → None。
pub(crate) fn sanitize_title(raw: &str) -> Option<String> {
    let mut s = raw.trim();
    // 成对引号包裹（模型常见输出习惯）。
    for (l, r) in [('"', '"'), ('「', '」'), ('『', '』'), ('《', '》')] {
        if s.starts_with(l) && s.ends_with(r) && s.chars().count() > 2 {
            s = s.strip_prefix(l).unwrap_or(s).strip_suffix(r).unwrap_or(s);
        }
    }
    // 多行输出取首行（标题单行）。
    let s = s.lines().next().unwrap_or("").trim();
    // 去句末标点。
    let s = s.trim_end_matches(['。', '.', '！', '!', '？', '?', '，', ',']);
    // 折叠内部空白。
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let collapsed = collapsed.trim();
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(60).collect())
}

/// 追加 pi 原生 session_info 行（parentId = 末条条目 id，树链一致；
/// pi 自身 appendSessionInfo 同款形状）。
fn append_session_info(path: &std::path::Path, title: &str) -> std::io::Result<()> {
    let content = std::fs::read_to_string(path)?;
    let parent_id: Option<String> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .last()
        .and_then(|l| {
            serde_json::from_str::<serde_json::Value>(l)
                .ok()
                .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(str::to_string))
        });
    let id = format!("{:08x}", rand_hex());
    let entry = serde_json::json!({
        "type": "session_info",
        "id": id,
        "parentId": parent_id,
        "timestamp": iso_now(),
        "name": title,
    });
    let mut file = std::fs::OpenOptions::new().append(true).open(path)?;
    let mut line = entry.to_string();
    line.push('\n');
    file.write_all(line.as_bytes())
}

fn rand_hex() -> u32 {
    // 时间戳低位 + 地址熵（无需密码学随机；id 仅需文件内唯一）。
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let a = &t as *const u64 as u64;
    (t.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ a.rotate_left(17)) as u32
}

fn iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    // 简易 UTC ISO8601（与 pi 条目 timestamp 同形：2026-09-22T00:00:00.000Z）。
    let days = secs / 86_400;
    let (y, mo, d) = civil_from_days(days as i64);
    let rem = secs % 86_400;
    format!(
        "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// 天数 → 公历日期（Howard Hinnant 算法）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_quotes_and_punctuation() {
        assert_eq!(sanitize_title("「开启v0.9.4版本开发」").as_deref(), Some("开启v0.9.4版本开发"));
        assert_eq!(sanitize_title("\"Fix login bug\"").as_deref(), Some("Fix login bug"));
        assert_eq!(sanitize_title("修复标题。").as_deref(), Some("修复标题"));
        assert_eq!(sanitize_title("多行\n输出取首行").as_deref(), Some("多行"));
        assert_eq!(sanitize_title("   ").as_deref(), None);
        assert_eq!(sanitize_title("").as_deref(), None);
    }

    #[test]
    fn sanitize_caps_length() {
        let long = "字".repeat(80);
        let s = sanitize_title(&long).unwrap();
        assert_eq!(s.chars().count(), 60);
    }

    #[test]
    fn session_info_detection_and_first_user() {
        let lines = vec![
            r#"{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"<jishu-tool-plugins>注入块</jishu-tool-plugins>\n开启v0.9.4版本开发"}]}}"#,
            r#"{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"收到"}],"provider":"zhipu","model":"glm-5.3"}}"#,
        ];
        assert!(!has_session_info(&lines));
        let user = first_user_text_from_lines(&lines).unwrap();
        assert!(user.contains("开启v0.9.4版本开发"));
        assert!(!user.contains("jishu-tool-plugins"));
        assert_eq!(
            last_model_from_lines(&lines),
            Some(("zhipu".to_string(), "glm-5.3".to_string()))
        );

        let named = vec![
            lines[0],
            r#"{"type":"session_info","id":"n1","name":"已有命名"}"#,
        ];
        assert!(has_session_info(&named));
    }

    #[test]
    fn append_session_info_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
                "\n"
            ),
        )
        .unwrap();
        append_session_info(&path, "测试标题").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        let last = content.lines().last().unwrap();
        let v: serde_json::Value = serde_json::from_str(last).unwrap();
        assert_eq!(v["type"], "session_info");
        assert_eq!(v["name"], "测试标题");
        assert_eq!(v["parentId"], "u1");
        assert!(v["id"].as_str().unwrap().len() == 8);
        assert!(v["timestamp"].as_str().unwrap().ends_with('Z'));
        // pi 语义：重读后 has_session_info 命中（幂等跳过）。
        let lines: Vec<&str> = content.lines().collect();
        assert!(has_session_info(&lines));
    }
}
