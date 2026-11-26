//! v0.9.8 需求7 补充（用户裁决 2026-11-22）：会话 / 命令清单对齐 TUI——
//! hub 不写死，直接调 pi（TUI）的 `get_commands` RPC 拉真实命令集。
//!
//! 通道（pi 零改动，全部现成接口）：
//! - 一次性 spawn `pi --mode rpc`（与需求15-F2 verify_engine_boot 同款
//!   探针模式）→ 发 `{"type":"get_commands"}` → 读 stdout 响应 → 杀进程；
//! - 返回扩展命令（extension）+ 提示模板（prompt）+ 技能（skill:前缀）
//!   三源清单——skill/模板随用户目录实时变化，写死必然漂移；
//! - builtin 26 条不在 get_commands 返回内（TUI 本地拦截）——hub 面板的
//!   builtin 子集由前端执行映射承载（名字对齐 pi slash-commands.ts）。
//!
//! 缓存：进程级 10 分钟 TTL（清单随扩展/技能装载变化，短 TTL 平衡
//! spawn 成本；面板每次打开走命令拉取）。

use std::sync::Mutex;
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(600);
/// 探针限时：对齐 verify_engine_boot（冷启动含扩展装载秒级，60s 覆盖慢机）。
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct PiSlashCommand {
    pub name: String,
    pub description: String,
    /// extension | prompt | skill
    pub source: String,
}

static CACHE: Mutex<Option<(Vec<PiSlashCommand>, Instant)>> = Mutex::new(None);

/// 拉取 pi 真实命令集（缓存优先）。失败返回空列表——面板回落仅 builtin
/// 可执行子集（清单拉不到不阻断输入体验）。
pub async fn fetch_pi_slash_commands() -> Vec<PiSlashCommand> {
    {
        let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached, at)) = guard.as_ref() {
            if at.elapsed() < CACHE_TTL {
                return cached.clone();
            }
        }
    }
    match fetch_once().await {
        Ok(commands) => {
            *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((commands.clone(), Instant::now()));
            commands
        }
        Err(e) => {
            log::warn!("[slash-commands] 拉取 pi 命令集失败（面板回落 builtin 子集）: {e}");
            Vec::new()
        }
    }
}

/// 一次性探针：spawn pi --mode rpc → get_commands → 响应即退。
async fn fetch_once() -> Result<Vec<PiSlashCommand>, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let runtime = super::pi_runtime::resolve_pi_runtime()
        .map_err(|e| format!("无法解析 pi 运行时: {e}"))?;
    let mut args = runtime.base_args;
    args.push("--mode".to_string());
    args.push("rpc".to_string());

    let mut cmd = crate::os_adapter::shell::shell_command(&runtime.program.to_string_lossy(), args);
    cmd.current_dir(std::env::temp_dir())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    // v0.9.8 评审修复轮 R2：探针绝不常驻——等待响应的 future 被丢弃（调用方
    // 取消 / 超时提前返回）时，靠 drop 兜底杀掉子进程。此前只靠函数走到末尾
    // 的 `child.kill()`：中途返回就留下孤儿引擎进程（每次挂载命令面板探一次）。
    // 与 verify_engine_boot / precheck_extension 的探针同款。
    cmd.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    crate::process_command::tokio_no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("spawn pi rpc 失败: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("pi rpc 无 stdin")?;
    let stdout = child.stdout.take().ok_or("pi rpc 无 stdout")?;

    let request = serde_json::json!({"type": "get_commands", "id": "hub-slash-list"});
    stdin
        .write_all(format!("{}\n", request).as_bytes())
        .await
        .map_err(|e| format!("写入 get_commands 失败: {e}"))?;
    stdin.flush().await.map_err(|e| format!("flush 失败: {e}"))?;
    drop(stdin); // 触发 pi 优雅退出（stdin 关闭即 shutdown）

    let mut reader = BufReader::new(stdout).lines();
    let deadline = tokio::time::timeout(FETCH_TIMEOUT, async {
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(commands) = parse_commands_response(&line) {
                return Some(commands);
            }
        }
        None
    })
    .await
    .map_err(|_| "get_commands 超时（60s）".to_string())?;

    let _ = child.kill().await;
    deadline.ok_or_else(|| "pi rpc 未返回 get_commands 响应".to_string())
}

/// 解析一行 stdout：`type=response & command=get_commands` → 命令数组。
/// 纯函数（单测锚定 pi 响应契约）。
fn parse_commands_response(line: &str) -> Option<Vec<PiSlashCommand>> {
    let msg: serde_json::Value = serde_json::from_str(line).ok()?;
    if msg.get("type").and_then(|v| v.as_str()) != Some("response") {
        return None;
    }
    if msg.get("command").and_then(|v| v.as_str()) != Some("get_commands") {
        return None;
    }
    if !msg.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
        return None;
    }
    let arr = msg.get("data")?.get("commands")?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|c| {
                let name = c.get("name")?.as_str()?.to_string();
                if name.is_empty() {
                    return None;
                }
                Some(PiSlashCommand {
                    name,
                    description: c
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    source: c
                        .get("source")
                        .and_then(|v| v.as_str())
                        .unwrap_or("extension")
                        .to_string(),
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_get_commands_response() {
        // pi rpc-mode get_commands 响应契约（rpc-mode.ts case "get_commands"）。
        let line = r#"{"type":"response","id":"hub-slash-list","command":"get_commands","success":true,"data":{"commands":[{"name":"todo","description":"更新待办","source":"extension","sourceInfo":{}},{"name":"skill:jishu-cli-guide","description":"命令行指南","source":"skill","sourceInfo":{}},{"name":"review","description":"代码评审模板","source":"prompt","sourceInfo":{}}]}}"#;
        let commands = parse_commands_response(line).unwrap();
        assert_eq!(commands.len(), 3);
        assert_eq!(commands[0].name, "todo");
        assert_eq!(commands[0].source, "extension");
        assert_eq!(commands[2].source, "prompt");
    }

    #[test]
    fn parse_ignores_non_matching_lines() {
        assert!(parse_commands_response("not json").is_none());
        assert!(parse_commands_response(r#"{"type":"event"}"#).is_none());
        assert!(parse_commands_response(
            r#"{"type":"response","command":"prompt","success":true}"#
        )
        .is_none());
        assert!(parse_commands_response(
            r#"{"type":"response","command":"get_commands","success":false,"error":"x"}"#
        )
        .is_none());
        // 空名条目滤除。
        assert_eq!(
            parse_commands_response(
                r#"{"type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"","source":"extension"}]}}"#
            )
            .unwrap()
            .len(),
            0
        );
    }
}
