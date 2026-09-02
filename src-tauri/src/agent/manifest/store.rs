//! hub 侧会话存储（v0.8.1 需求1 M2，store="hub"）：JSONL 追加式落盘。
//!
//! 路径：`~/.jishu-hub/agent-sessions/<agent_id>/<encoded_name>/<session_id>.jsonl`
//! （encoded_name 与 SessionAdapter 既有签名对齐，按项目分组）。
//! 格式：首行 `session_meta`（title/created_at），其后每行一个
//! `session::Message`；读侧逐行反序列化，坏行跳过并 log（半写容忍）。
//! 写入追加式——以 turn 为粒度 append，幂等性由前端「每 turn 提交一次」
//! 保证（重复提交重复追加的风险接受并记录）。

use crate::session::{Message, Session};
use std::path::PathBuf;

/// 单个会话文件的首行元数据（title = 首条用户消息截断）。
#[derive(serde::Serialize, serde::Deserialize)]
struct SessionMeta {
    #[serde(rename = "type")]
    kind: String,
    title: String,
    created_at: i64,
}

fn session_dir(agent_id: &str, encoded_name: &str) -> PathBuf {
    super::hub_home()
        .join("agent-sessions")
        .join(agent_id)
        .join(encoded_name)
}

fn session_file(agent_id: &str, encoded_name: &str, session_id: &str) -> PathBuf {
    session_dir(agent_id, encoded_name).join(format!("{session_id}.jsonl"))
}

fn title_from(messages: &[Message]) -> String {
    let first_user = messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| {
            m.content
                .iter()
                .filter_map(|b| match b {
                    crate::session::ContentBlock::Text { text, .. } => Some(text.clone()),
                    _ => None,
                })
                .collect::<String>()
        })
        .unwrap_or_default();
    let title = first_user.trim();
    if title.is_empty() {
        "New Session".to_string()
    } else {
        title.chars().take(80).collect()
    }
}

/// 追加一个 turn 的消息（首写时落 meta 行）。
pub fn persist_turn(
    agent_id: &str,
    encoded_name: &str,
    session_id: &str,
    messages: &[Message],
) -> Result<(), String> {
    persist_turn_at(&session_file(agent_id, encoded_name, session_id), messages)
}

fn persist_turn_at(file: &std::path::Path, messages: &[Message]) -> Result<(), String> {
    if messages.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(file.parent().unwrap_or(&file))
        .map_err(|e| format!("create session dir: {e}"))?;
    let is_new = !file.exists();
    use std::io::Write;
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| format!("open session file: {e}"))?;
    if is_new {
        let meta = SessionMeta {
            kind: "session_meta".to_string(),
            title: title_from(messages),
            created_at: crate::util::now_ms(),
        };
        serde_json::to_writer(&mut out, &meta).map_err(|e| format!("write meta: {e}"))?;
        let _ = out.write_all(b"\n");
    }
    for message in messages {
        serde_json::to_writer(&mut out, message).map_err(|e| format!("write message: {e}"))?;
        let _ = out.write_all(b"\n");
    }
    Ok(())
}

/// 读取会话全部消息（meta 行跳过；坏行跳过并 log）。
pub fn read_messages(
    agent_id: &str,
    encoded_name: &str,
    session_id: &str,
) -> Result<Vec<Message>, String> {
    read_messages_at(&session_file(agent_id, encoded_name, session_id), agent_id, encoded_name, session_id)
}

fn read_messages_at(
    file: &std::path::Path,
    agent_id: &str,
    encoded_name: &str,
    session_id: &str,
) -> Result<Vec<Message>, String> {
    let content = std::fs::read_to_string(file).map_err(|e| format!("read session: {e}"))?;
    let mut messages = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        // meta 行（首行）与坏行都跳过——半写容忍。
        if idx == 0 && line.contains("\"session_meta\"") {
            continue;
        }
        match serde_json::from_str::<Message>(line) {
            Ok(message) => messages.push(message),
            Err(err) => log::warn!(
                "[hub-session] skip bad line in {}/{}/{}: {err}",
                agent_id,
                encoded_name,
                session_id
            ),
        }
    }
    Ok(messages)
}

/// 列出某项目下全部会话（id=文件名；title/时间取 meta 行；孤儿跳过）。
pub fn list_sessions(agent_id: &str, encoded_name: &str) -> Vec<Session> {
    list_sessions_at(&session_dir(agent_id, encoded_name))
}

fn list_sessions_at(dir: &std::path::Path) -> Vec<Session> {
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let agent_id = "";
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let mut title = String::new();
        let mut created_at: Option<i64> = None;
        if let Some(first_line) = content.lines().next() {
            if let Ok(meta) = serde_json::from_str::<SessionMeta>(first_line) {
                if meta.kind == "session_meta" {
                    title = meta.title;
                    created_at = Some(meta.created_at);
                }
            }
        }
        // 无 meta 的孤儿文件跳过（非 hub 存储写入的文件不展览）。
        if created_at.is_none() {
            continue;
        }
        sessions.push(Session {
            id: stem.to_string(),
            path: path.clone(),
            agent_id: if agent_id.is_empty() { None } else { Some(agent_id.to_string()) },
            messages: Vec::new(),
            started_at: created_at.map(|ms| {
                chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default()
            }),
            display_name: if title.is_empty() { None } else { Some(title) },
            last_active: None,
            project_path: None,
        });
    }
    sessions
}

/// 删除会话文件（对齐 SESSION_DELETE 能力门控）。
pub fn delete_session(agent_id: &str, encoded_name: &str, session_id: &str) -> Result<(), String> {
    let file = session_file(agent_id, encoded_name, session_id);
    std::fs::remove_file(&file).map_err(|e| format!("delete session: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{ContentBlock, Message};

    fn msg(role: &str, text: &str) -> Message {
        Message {
            role: role.to_string(),
            content: vec![ContentBlock::Text {
                text: text.to_string(),
                tool_ids: Vec::new(),
            }],
            timestamp: None,
        }
    }

    #[test]
    fn roundtrip_and_listing() {
        // 直接注入 tempdir 路径：绕开 hub_home() 的 JISHU_HUB_HOME env
        // （并行测试 set_var 竞态会让读写落到不同目录）。
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("s1.jsonl");
        let messages = vec![msg("user", "hello world"), msg("assistant", "hi")];
        persist_turn_at(&file, &messages).expect("persist");
        // 追加第二个 turn
        let turn2 = vec![msg("user", "again"), msg("assistant", "ok")];
        persist_turn_at(&file, &turn2).expect("persist 2");

        let read =
            read_messages_at(&file, "test-agent", "proj", "s1").expect("read");
        assert_eq!(read.len(), 4);
        assert_eq!(read[0].role, "user");

        let list = list_sessions_at(dir.path());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "s1");
        assert_eq!(list[0].display_name.as_deref(), Some("hello world"));
    }
}
