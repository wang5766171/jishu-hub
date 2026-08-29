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
        let tool = plugin
            .file
            .tool
            .as_ref()
            .expect("tool plugin validated to have [tool] section");
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

/// 剥离所有工具相关标记（v0.8.1 需求10 统一入口）：
/// 1. `<jishu-tool-plugins>...</jishu-tool-plugins>` 注入块
/// 2. `[JISHU-TOOLS:...]` 内嵌标记（用户消息前缀）
/// 标题提取、会话列表名等展示面统一经此清洗。
pub fn strip_all_markers(text: &str) -> String {
    let stripped_block = strip_tool_block(text);
    // 剥离前缀标记（可能有多个，循环匹配）。
    let re = regex::Regex::new(r"^\[JISHU-TOOLS:[^\]]+\]\s?").unwrap();
    let mut result = stripped_block;
    loop {
        let new = re.replace(&result, "").to_string();
        if new == result {
            break;
        }
        result = new;
    }
    result.trim_start().to_string()
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
}
