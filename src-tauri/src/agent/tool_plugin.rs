//! 工具插件（v0.8.1 需求7）：CLI 能力单元（如钉钉 CLI、github-cli）。
//!
//! 与智能体插件同目录（`~/.jishu-hub/agents/*.toml`）、同 schema 家族，按
//! manifest 顶层 `kind = "tool"` 分流——**不进 AgentRegistry**（无会话语义）。
//! 使用面：会话输入区「+」菜单勾选后，send_message 组装 prompt 时把选中
//! 工具的说明块作为前缀注入智能体上下文（智能体经其原生 shell 工具调用，
//! 审批走既有策略链）。历史回放在 get_session_messages 命令层剥离标记块。
//!
//! 会话启用集合持久化于 `~/.jishu-hub/session-tools.json`
//! （{ sessionId: [toolId] }，hub 会话状态文件族先例；读写失败降级）。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use super::manifest::schema::AgentManifestFile;

/// 注入块的标记对：agent 原生历史会记录注入后的消息，回放时剥离。
pub const TOOL_BLOCK_OPEN: &str = "<jishu-tool-plugins>";
pub const TOOL_BLOCK_CLOSE: &str = "</jishu-tool-plugins>";

#[derive(Debug)]
pub struct ToolPlugin {
    pub file: Arc<AgentManifestFile>,
    pub source_path: PathBuf,
    pub enabled: bool,
    /// 命令可执行性探测缓存（None=未探测；Some(bool)=PATH 解析结果）。
    /// 注入块渲染时惰性探测一次——避免每次 send_message 重复跑 where/which。
    installed_cache: std::sync::Mutex<Option<bool>>,
}

impl ToolPlugin {
    /// 测试构造（绕过私有 installed_cache 字段）。
    #[cfg(test)]
    pub fn for_test(
        file: Arc<AgentManifestFile>,
        source_path: PathBuf,
        enabled: bool,
    ) -> Self {
        Self {
            file,
            source_path,
            enabled,
            installed_cache: std::sync::Mutex::new(None),
        }
    }

    /// 命令是否可执行（PATH 解析，缓存）。无 [probe] 段视为未检测到。
    pub fn installed(&self) -> bool {
        let mut cache = self
            .installed_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(known) = *cache {
            return known;
        }
        let known = self.probe_installed().is_some();
        *cache = Some(known);
        known
    }

    pub fn id(&self) -> &str {
        &self.file.info.id
    }

    /// 安装探测（PATH 解析 + 可选版本），与 manifest agent 的 probe 同源。
    pub fn probe_installed(&self) -> Option<String> {
        let probe = self.file.probe.as_ref()?;
        let name = probe.command.as_str();
        let path = super::discovery::probe_binary_sync(name, &[name])?;
        let version = match (&probe.version_args, &probe.version_regex) {
            (Some(version_args), _) => super::manifest::agent::probe_version_with_args(
                &path,
                version_args,
                probe.version_regex.as_deref(),
            ),
            _ => super::discovery::version_of_sync(&path),
        };
        Some(version.unwrap_or_else(|| "".to_string()))
    }
}

/// 装载全部工具插件（kind = "tool" 的合法 manifest，disabled 过滤）。
pub fn load_tool_plugins(disabled: &HashSet<String>) -> Vec<ToolPlugin> {
    // 复用 load_manifests 的解析与校验（agent 与 tool 共享 id namespace，
    // builtin_ids 传空——工具 id 与内置 id 的冲突在此不拦，装载侧由
    // install_manifest_file 的统一冲突检查守门）。
    let (_agents, tools, _errors) = super::manifest::load_manifests(&[]);
    tools
        .into_iter()
        .map(|(file, path)| {
            let enabled = !disabled.contains(&file.info.id);
            ToolPlugin {
                file: Arc::new(file),
                source_path: path,
                enabled,
                installed_cache: std::sync::Mutex::new(None),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 会话启用状态（session-tools.json）
// ---------------------------------------------------------------------------

fn session_tools_path() -> PathBuf {
    super::manifest::hub_home().join("session-tools.json")
}

/// session-tools.json 读-改-写互斥（M6：多线程 Tauri 命令并发进入
/// set/migrate 时 atomic_write 只保证单次写原子，不保证读改写整体——
/// 两会话同时勾选会丢更新。所有写路径经此锁串行）。
static SESSION_TOOLS_WRITE_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn load_session_tools_map() -> std::collections::HashMap<String, Vec<String>> {
    let Ok(content) = std::fs::read_to_string(session_tools_path()) else {
        return std::collections::HashMap::new();
    };
    serde_json::from_str(&content).unwrap_or_else(|e| {
        log::warn!("[tool-plugin] invalid session-tools.json ({e}), ignoring");
        std::collections::HashMap::new()
    })
}

fn save_session_tools_map(map: &std::collections::HashMap<String, Vec<String>>) {
    let path = session_tools_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(map) {
        if let Err(e) = crate::util::atomic_write(&path, content.as_bytes()) {
            log::warn!("[tool-plugin] cannot save session-tools.json: {e}");
        }
    }
}

/// 测试注入：直接覆写 session-tools.json（绕过 unknown-id 校验）。
#[cfg(test)]
pub fn set_session_tools_map_for_test(map: &std::collections::HashMap<String, Vec<String>>) {
    let _guard = SESSION_TOOLS_WRITE_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    save_session_tools_map(map);
}

/// 读取会话启用的工具 id 集合（按装载顺序稳定排序）。
/// 新会话（尚无真实 session id）的工具选择暂存 key——前端在 sessionId 为
/// null 时用它读写；send_message 首条消息时迁移到真实 pending id 后清空。
pub const STAGING_SESSION_KEY: &str = "__new_session__";

pub fn get_session_tools(session_id: &str) -> Vec<String> {
    let map = load_session_tools_map();
    map.get(session_id).cloned().unwrap_or_default()
}

/// 写会话启用集合（未知工具 id 拒绝——防配置漂移；空集合移除条目）。
pub fn set_session_tools(session_id: &str, tool_ids: &[String]) -> Result<(), String> {
    let known: HashSet<String> = load_tool_plugins(&HashSet::new())
        .iter()
        .map(|p| p.id().to_string())
        .collect();
    for id in tool_ids {
        if !known.contains(id) {
            return Err(format!("Unknown tool plugin: {id}"));
        }
    }
    let _guard = SESSION_TOOLS_WRITE_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut map = load_session_tools_map();
    if tool_ids.is_empty() {
        map.remove(session_id);
    } else {
        let mut sorted = tool_ids.to_vec();
        sorted.sort();
        sorted.dedup();
        map.insert(session_id.to_string(), sorted);
    }
    save_session_tools_map(&map);
    Ok(())
}

/// 迁移会话工具集：`from` 存在则并入（并集去重）`to` 并删除 `from` 条目。
/// 两个挂载点（M0）：
/// 1. send_message 注入前：STAGING_SESSION_KEY → 本条 sessionId——新会话在
///    输入框勾选的工具（暂存键）随首条消息落到 pending/真实键；
/// 2. 会话 id 解析回调：pending-<ts> → 真实 session id——首条消息解析出
///    真实 id 后工具集跟着搬家，第二条消息起按真实键命中注入。
/// from == to 或 from 不存在时为无操作（幂等）。
pub fn migrate_session_tools(from: &str, to: &str) {
    if from == to {
        return;
    }
    let _guard = SESSION_TOOLS_WRITE_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut map = load_session_tools_map();
    let Some(mut moved) = map.remove(from) else {
        return;
    };
    match map.get_mut(to) {
        Some(existing) => {
            existing.append(&mut moved);
            existing.sort();
            existing.dedup();
        }
        None => {
            moved.sort();
            moved.dedup();
            map.insert(to.to_string(), moved);
        }
    }
    save_session_tools_map(&map);
}

/// 启动清扫：删除 session-tools.json 中的孤儿 `pending-*` 键（M0）。
/// pending-<ts> 是一次性的首条消息发送键，正常路径在会话解析时已迁移到
/// 真实 id；残留（发送中断/崩溃）只占位并可能串扰，统一清理。
pub fn cleanup_stale_pending_sessions() {
    let _guard = SESSION_TOOLS_WRITE_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut map = load_session_tools_map();
    let before = map.len();
    map.retain(|k, _| !k.starts_with("pending-"));
    if map.len() != before {
        save_session_tools_map(&map);
        log::info!(
            "[tool-plugin] cleaned {} stale pending-* session tool entries",
            before - map.len()
        );
    }
}

// ---------------------------------------------------------------------------
// 注入与剥离
// ---------------------------------------------------------------------------

/// 渲染注入块：紧凑说明（每工具 3-5 行），标记对包裹供回放剥离。
pub fn render_tool_block(plugins: &[&ToolPlugin]) -> String {
    let mut out = String::new();
    out.push_str(TOOL_BLOCK_OPEN);
    out.push('\n');
    out.push_str(
        "本会话启用了以下工具插件。用法给出命令模板的，直接经你的 shell 工具执行（遵循既有审批规则）；\n",
    );
    out.push_str(
        "标注「命令未检测到」的（或用法为能力描述而非命令的），不要尝试按插件名调用命令——按其描述用等效的 shell 方式实现该能力。\n",
    );
    for plugin in plugins {
        // M3 → v0.9.0 需求2 接线：注入参与判定收敛到 adaptive 引擎
        //（participates_in_injection = 有 [tool] 段；PiOnly 形态走 pi 扩展
        // 部署管线，不进 prompt 注入——跳过而非 panic）。
        if !super::adaptive::participates_in_injection(&plugin.file) {
            log::debug!(
                "[tool-plugin] skip {} in prompt injection (no [tool] section; pi-extension-only)",
                plugin.id()
            );
            continue;
        }
        let Some(tool) = plugin.file.tool.as_ref() else {
            continue;
        };
        out.push_str(&format!(
            "\n## {} — {}\n",
            plugin.file.info.id, tool.description
        ));
        out.push_str(&format!("用法: {}\n", tool.usage));
        let status: &str = if plugin.installed() {
            "状态: 命令已安装，可直接执行"
        } else {
            "状态: 命令未检测到——按描述用等效 shell 方式实现，不要按插件名调用"
        };
        out.push_str(status);
        out.push('\n');
        if let Some(example) = &tool.example {
            out.push_str(&format!("示例: {example}\n"));
        }
        if let Some(notes) = &tool.notes {
            out.push_str(&format!("注意: {notes}\n"));
        }
    }
    out.push_str(TOOL_BLOCK_CLOSE);
    out
}

/// 回放派生（v0.9.0 需求3 方案 C）：剥注入块 + 从块内 `## <id> — <desc>`
/// 头提取本条消息的工具 id 快照。注入块随 compose 后 prompt 持久化进各家
/// 原生 JSONL，是每条消息工具快照的唯一保真来源（文本标记方案已按版本级
/// 裁决整体废弃，无旧数据兼容层）。无块时原样返回、快照为空。
pub fn extract_tool_snapshot(text: &str) -> (String, Vec<String>) {
    let Some(start) = text.find(TOOL_BLOCK_OPEN) else {
        return (text.to_string(), Vec::new());
    };
    let mut ids: Vec<String> = Vec::new();
    if let Some(end_rel) = text[start..].find(TOOL_BLOCK_CLOSE) {
        let block = &text[start..start + end_rel];
        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("## ") {
                if let Some((id, _)) = rest.split_once(" — ") {
                    let id = id.trim();
                    if !id.is_empty() && !ids.iter().any(|x| x == id) {
                        ids.push(id.to_string());
                    }
                }
            }
        }
    }
    (strip_tool_block(text), ids)
}

/// 剥离注入块（回放路径）。兼容块后紧跟的空行残留；无标记时原样返回。
pub fn strip_tool_block(text: &str) -> String {
    let Some(start) = text.find(TOOL_BLOCK_OPEN) else {
        return text.to_string();
    };
    let mut result = String::new();
    result.push_str(&text[..start]);
    if let Some(end_rel) = text[start..].find(TOOL_BLOCK_CLOSE) {
        let after = &text[start + end_rel + TOOL_BLOCK_CLOSE.len()..];
        // 块与消息之间的分隔空行（含 CRLF 序列）一并吃掉，避免前导空行。
        result.push_str(after.trim_start_matches(['\r', '\n']));
    } else {
        // 未闭合（异常半写）：丢弃其后内容，保守清理。
    }
    // 前缀剥离后的尾部空白（块在末尾时）。
    result.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::manifest::schema::{
        InfoSection, ManifestKind, ToolSection, TransportSection,
    };

    use crate::agent::manifest::env_test_lock;

    fn tool_plugin_no_tool_section(id: &str) -> ToolPlugin {
        ToolPlugin {
            file: Arc::new(AgentManifestFile {
                schema: 1,
                kind: ManifestKind::Tool,
                info: InfoSection {
                    id: id.to_string(),
                    display_name: id.to_string(),
                    icon: String::new(),
                    install_hint: None,
                },
                probe: None,
                transport: None,
                config: None,
                session: None,
                capabilities: None,
                pi_extension: Some(super::super::manifest::schema::PiExtensionSection {
                    entry: "discuss.ts".to_string(),
                    target_agent: "jishu-self".to_string(),
                }),
                mcp: None,
                tool: None,
            }),
            source_path: PathBuf::from(format!("/agents/{id}.toml")),
            enabled: true,
            installed_cache: std::sync::Mutex::new(None),
        }
    }

    fn tool_plugin(
        id: &str,
        description: &str,
        usage: &str,
        example: Option<&str>,
        notes: Option<&str>,
    ) -> ToolPlugin {
        ToolPlugin {
            file: Arc::new(AgentManifestFile {
                schema: 1,
                kind: ManifestKind::Tool,
                info: InfoSection {
                    id: id.to_string(),
                    display_name: id.to_string(),
                    icon: String::new(),
                    install_hint: None,
                },
                probe: None,
                transport: None,
                config: None,
                session: None,
                capabilities: None,
                pi_extension: None,
                mcp: None,
                tool: Some(ToolSection {
                    description: description.to_string(),
                    usage: usage.to_string(),
                    example: example.map(str::to_string),
                    notes: notes.map(str::to_string),
                }),
            }),
            source_path: PathBuf::from(format!("/agents/{id}.toml")),
            enabled: true,
            installed_cache: std::sync::Mutex::new(None),
        }
    }

    #[test]
    fn render_and_strip_roundtrip() {
        let plugins = vec![
            tool_plugin(
                "gh",
                "GitHub CLI",
                "gh pr list",
                Some("gh pr view 42"),
                Some("需要登录"),
            ),
            tool_plugin("dingtalk", "钉钉", "dt send --to x", None, None),
        ];
        let refs: Vec<&ToolPlugin> = plugins.iter().collect();
        let block = render_tool_block(&refs);
        assert!(block.starts_with(TOOL_BLOCK_OPEN));
        assert!(block.ends_with(TOOL_BLOCK_CLOSE));
        assert!(block.contains("## gh — GitHub CLI"));
        // 无 [probe] 的 fixture → 状态行走「未检测到」分支（引导等效实现）。
        assert!(block.contains("状态: 命令未检测到"));
        assert!(block.contains("用法: gh pr list"));
        assert!(block.contains("示例: gh pr view 42"));
        assert!(block.contains("注意: 需要登录"));

        // 注入形态：块 + 空行 + 用户消息
        let injected = format!("{block}\n\n帮我看一下 PR 列表");
        assert_eq!(strip_tool_block(&injected), "帮我看一下 PR 列表");
        // 无块原样
        assert_eq!(strip_tool_block("普通消息"), "普通消息");
        // 块在末尾
        assert_eq!(strip_tool_block(&format!("消息\n\n{block}")), "消息");
        // 未闭合块：清理
        assert_eq!(
            strip_tool_block(&format!("msg\n{TOOL_BLOCK_OPEN}\nbroken")),
            "msg"
        );
    }

    #[test]
    fn strip_is_idempotent_and_handles_crlf() {
        let block = render_tool_block(&[&tool_plugin("a", "A", "a run", None, None)]);
        let injected = format!("{block}\r\n\r\nhi");
        let once = strip_tool_block(&injected);
        assert_eq!(once, "hi");
        assert_eq!(strip_tool_block(&once), once);
    }

    #[test]
    fn tool_manifest_toml_parses_and_validates() {
        let src = r#"
schema = 1
kind = "tool"
[info]
id = "gh"
display_name = "GitHub CLI"
install_hint = "npm i -g @github/cli"
[probe]
command = "gh"
[tool]
description = "GitHub 仓库与 PR 操作"
usage = "gh pr list --repo <owner>/<repo>"
example = "gh pr view 42"
notes = "需要 gh auth login"
"#;
        let file: AgentManifestFile = toml::from_str(src).unwrap();
        assert_eq!(file.kind, ManifestKind::Tool);
        assert!(file.validate().is_ok());

        // tool 形态带 transport → 拒绝
        let bad = r#"
schema = 1
kind = "tool"
[info]
id = "x"
display_name = "X"
[tool]
description = "d"
usage = "u"
[transport]
kind = "cli"
chat_command = ["x", "{prompt}"]
"#;
        let file: AgentManifestFile = toml::from_str(bad).unwrap();
        assert!(file.validate().unwrap_err().contains("[transport]"));

        // agent 形态（缺省 kind）带 [tool] → 拒绝
        let bad2 = r#"
schema = 1
[info]
id = "x"
display_name = "X"
[transport]
kind = "cli"
chat_command = ["x", "{prompt}"]
[tool]
description = "d"
usage = "u"
"#;
        let file: AgentManifestFile = toml::from_str(bad2).unwrap();
        assert!(file.validate().unwrap_err().contains("[tool]"));
    }
    // ── M0/M3 回归测试：staging 迁移 / pending 清扫 / 无 [tool] 段 skip ──

    #[test]
    fn render_skips_plugin_without_tool_section() {
        // M3：schema 允许 kind=tool 仅含 [pi_extension]——修前 render 的
        // .expect 直接 panic。现在应跳过该插件，块内只有另一个正常插件。
        let pi_only = tool_plugin_no_tool_section("pi-only");
        let normal = tool_plugin("normal", "d", "u", None, None);
        let block = render_tool_block(&[&pi_only, &normal]);
        assert!(block.contains("normal"));
        assert!(!block.contains("pi-only"));
    }

    #[test]
    fn session_tools_set_get_and_empty_cleanup() {
        let _guard = env_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        // set 校验未知 id 会扫 manifest 目录——用装载目录里不存在的 id 即拒绝
        assert!(set_session_tools("s1", &["no-such-tool".into()]).is_err());
        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn migrate_session_tools_merges_and_clears_source() {
        let _guard = env_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        // 直接写 map 文件绕过 unknown-id 校验（迁移逻辑只操作 map）
        let mut map = std::collections::HashMap::new();
        map.insert(
            "__new_session__".to_string(),
            vec!["tool-a".to_string()],
        );
        map.insert(
            "target-session".to_string(),
            vec!["tool-b".to_string()],
        );
        save_session_tools_map(&map);

        migrate_session_tools(STAGING_SESSION_KEY, "target-session");
        let merged = get_session_tools("target-session");
        assert!(merged.contains(&"tool-a".to_string()));
        assert!(merged.contains(&"tool-b".to_string()));
        assert!(get_session_tools(STAGING_SESSION_KEY).is_empty());

        // 幂等：from 不存在时无操作
        migrate_session_tools(STAGING_SESSION_KEY, "target-session");
        assert_eq!(get_session_tools("target-session").len(), 2);

        // from == to 无操作
        migrate_session_tools("target-session", "target-session");
        assert_eq!(get_session_tools("target-session").len(), 2);
        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn cleanup_stale_pending_sessions_removes_only_pending_keys() {
        let _guard = env_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        let mut map = std::collections::HashMap::new();
        map.insert("pending-1787962861840".to_string(), vec!["a".to_string()]);
        map.insert("__new_session__".to_string(), vec!["b".to_string()]);
        map.insert("real-session".to_string(), vec!["c".to_string()]);
        save_session_tools_map(&map);

        cleanup_stale_pending_sessions();
        assert!(get_session_tools("pending-1787962861840").is_empty());
        assert_eq!(get_session_tools("__new_session__"), vec!["b".to_string()]);
        assert_eq!(get_session_tools("real-session"), vec!["c".to_string()]);
        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn extract_tool_snapshot_parses_ids_and_strips_block() {
        // v0.9.0 需求3 方案 C：回放派生契约——注入块内 `## id — desc` 头
        // 提取 id 快照，块本身剥净。
        let block = format!(
            "{}\n## task-requirements — 需求讨论\n用法: x\n\n## task-plan — 方案规划\n用法: y\n{}",
            TOOL_BLOCK_OPEN, TOOL_BLOCK_CLOSE
        );
        let text = format!("{block}\n\n用户的问题正文");
        let (clean, ids) = extract_tool_snapshot(&text);
        assert_eq!(clean, "用户的问题正文");
        assert_eq!(ids, vec!["task-requirements", "task-plan"]);
    }

    #[test]
    fn extract_tool_snapshot_no_block_passthrough() {
        let (clean, ids) = extract_tool_snapshot("普通消息（无注入块）");
        assert_eq!(clean, "普通消息（无注入块）");
        assert!(ids.is_empty());
    }

    #[test]
    fn extract_tool_snapshot_dedup_keeps_order() {
        let block = format!(
            "{}\n## a — 一\n## a — 重复\n## b — 二\n{}",
            TOOL_BLOCK_OPEN, TOOL_BLOCK_CLOSE
        );
        let (_, ids) = extract_tool_snapshot(&block);
        assert_eq!(ids, vec!["a", "b"]);
    }
}
