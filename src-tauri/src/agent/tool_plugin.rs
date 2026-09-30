//! 工具插件（v0.8.1 需求7）：CLI 能力单元（如钉钉 CLI、github-cli）。
//!
//! 与智能体插件同目录（`~/.jishu-hub/agents/*.toml`）、同 schema 家族，按
//! manifest 顶层 `kind = "tool"` 分流——**不进 AgentRegistry**（无会话语义）。
//! 使用面：会话输入区「+」菜单勾选后，send_message 组装 prompt 时把选中
//! 工具的说明块作为后缀注入智能体上下文（智能体经其原生 shell 工具调用，
//! 审批走既有策略链）。历史回放在 get_session_messages 命令层剥离标记块
//! （注入标记与剥离链统一于 internal_prompts.rs）。
//!
//! 会话启用集合持久化于 `~/.jishu-hub/session-tools.json`
//! （{ sessionId: [toolId] }，hub 会话状态文件族先例；读写失败降级）。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use super::manifest::schema::{self, AgentManifestFile};

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
    pub fn for_test(file: Arc<AgentManifestFile>, source_path: PathBuf, enabled: bool) -> Self {
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

/// 渲染注入块：紧凑说明（每工具 3-5 行），标记对包裹供回放剥离
/// （标记与头部话术统一于 internal_prompts，头部话术带版本登记）。
pub fn render_tool_block(plugins: &[&ToolPlugin]) -> String {
    let mut out = String::new();
    out.push_str(super::internal_prompts::TOOL_BLOCK_OPEN);
    out.push('\n');
    out.push_str(&super::internal_prompts::PROMPT_TOOL_HEADER.body());
    out.push('\n');
    for plugin in plugins {
        // M3 → v0.9.0 需求2 接线：注入参与判定收敛到 adaptive 引擎
        //（participates_in_injection = 有 [tool]/[mcp]/[skill] 段；PiOnly
        // 形态走 pi 扩展部署管线，不进 prompt 注入——跳过而非 panic）。
        if !super::adaptive::participates_in_injection(&plugin.file) {
            log::debug!(
                "[tool-plugin] skip {} in prompt injection (no [tool]/[mcp]/[skill] section)",
                plugin.id()
            );
            continue;
        }
        // v0.9.0 需求20 第二轮：MCP/Skill 声明的小节（选中即注入提示；结构
        // 性可用与选择无关——MCP 经 jishu-hub 常驻通道，skill 已分发到 agent
        // skill 目录）。header 形态沿用 `## id — desc`（tool_ids 快照兼容）。
        if plugin.file.mcp.is_some() {
            out.push_str(&format!("\n## {} — MCP 服务\n", plugin.file.info.id));
            out.push_str(&format!(
                "本会话启用了 MCP 服务「{}」。调用它的工具时**优先**使用 jishu-hub 解析服务提供的、以 `{}__` 开头的 MCP 工具（结构化通道，直接调用，无需 shell、不要自行拼接命令行）；未选中的 MCP 服务同样经 jishu-hub 在线可用，按同样的 `插件id__` 前缀规则发现即可。\n",
                plugin.file.info.display_name, plugin.file.info.id
            ));
        }
        // v0.9.1 需求9：[skill] 单/双形态共用小节——单数沿用插件 id 名，
        // 多 skill 逐项列出（部署名 `<pid>__<name>`）。
        if let Some(decl) = plugin.file.skill.as_ref() {
            out.push_str(&format!("\n## {} — Skill\n", plugin.file.info.id));
            match decl {
                schema::SkillDecl::One(skill) => {
                    out.push_str(&format!(
                        "本会话启用了 skill「{}」：{}\n（skill 文件已在你可访问的 skill 目录中，按 skill 名即可使用。）\n",
                        plugin.file.info.id, skill.description
                    ));
                }
                schema::SkillDecl::Many(entries) => {
                    for e in entries {
                        out.push_str(&format!(
                            "本会话启用了 skill「{}__{}」：{}\n（skill 文件已在你可访问的 skill 目录中，按 skill 名即可使用。）\n",
                            plugin.file.info.id, e.name, e.description
                        ));
                    }
                }
            }
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
    out.push_str(super::internal_prompts::TOOL_BLOCK_CLOSE);
    out
}

/// v0.9.1 需求12：jishu-hub MCP 解析服务全局提示块——会话未勾选任何工具
/// 插件时注入（勾选路径走 render_tool_block，各服务小节已含同款指引），
/// 保证每个智能体每轮消息都能识别解析服务并优先经它调用 MCP 工具。
/// 存在**启用的** [mcp] 插件才产出（与聚合 server 的暴露范围一致）。
pub fn render_hub_mcp_resolver_hint(plugins: &[&ToolPlugin]) -> String {
    let has_mcp = plugins.iter().any(|p| p.enabled && p.file.mcp.is_some());
    if !has_mcp {
        return String::new();
    }
    // v0.9.2 用户裁决：用标记包裹，展示面按格式剥离（agent 可见、用户不可见）。
    // v0.9.4 需求9 P2：文案如实两步走——册子上的工具集是 spawn 时静态抄录，
    // hub_mcp_list/hub_mcp_call 先查后调实现热插拔；需求9 补充：任务驱动而非
    // 点名调用。
    // v0.9.5 重构：正文迁 resources/prompts/mcp-hint.md（internal_prompts
    // 版本登记，变更台账见该目录 CHANGELOG.md）。
    format!(
        "{}\n{}\n{}",
        super::internal_prompts::MCP_HINT_OPEN,
        super::internal_prompts::PROMPT_MCP_HINT.body(),
        super::internal_prompts::MCP_HINT_CLOSE
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::manifest::schema::{
        InfoSection, ManifestKind, ToolSection,
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
                    entry: Some("discuss.ts".to_string()),
                    target_agent: "jishu-self".to_string(),
                    tools: vec![],
                }),
                mcp: None,
                panel: None,
                skill: None,
                skills: None,
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
                panel: None,
                skill: None,
                skills: None,
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
        assert!(block.starts_with(crate::agent::internal_prompts::TOOL_BLOCK_OPEN));
        assert!(block.ends_with(crate::agent::internal_prompts::TOOL_BLOCK_CLOSE));
        assert!(block.contains("## gh — GitHub CLI"));
        // 无 [probe] 的 fixture → 状态行走「未检测到」分支（引导等效实现）。
        assert!(block.contains("状态: 命令未检测到"));
        assert!(block.contains("用法: gh pr list"));
        assert!(block.contains("示例: gh pr view 42"));
        assert!(block.contains("注意: 需要登录"));
        // 头部话术经 internal_prompts 版本登记（剥离 roundtrip 见其模块测试
        // 与 chat_tests 的 compose 契约测试）。
        assert!(block.contains("本会话启用了以下工具插件"));
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
    fn render_includes_mcp_and_skill_sections() {
        // v0.9.0 需求20 第二轮：MCP/Skill 小节渲染 + tool_ids 快照提取兼容。
        // Arc 构造：经 for_test/独立字面量建 manifest（file 是 Arc 不可变）。
        let mcp_plugin = ToolPlugin::for_test(
            std::sync::Arc::new(AgentManifestFile {
                schema: 1,
                kind: ManifestKind::Tool,
                info: InfoSection {
                    id: "mcp-x".to_string(),
                    display_name: "MCP X".to_string(),
                    icon: String::new(),
                    install_hint: None,
                },
                probe: None,
                transport: None,
                config: None,
                session: None,
                capabilities: None,
                pi_extension: None,
                mcp: Some(crate::agent::manifest::schema::McpSection {
                    transport: Default::default(),
                    command: Some("npx".into()),
                    args: None,
                    env: None,
                    url: None,
                    vision_tools: None,
                    headers: None,
                }),
                panel: None,
                skill: None,
                skills: None,
                tool: None,
            }),
            PathBuf::from("/agents/mcp-x.toml"),
            true,
        );
        let skill_plugin = ToolPlugin::for_test(
            std::sync::Arc::new(AgentManifestFile {
                schema: 1,
                kind: ManifestKind::Tool,
                info: InfoSection {
                    id: "skill-y".to_string(),
                    display_name: "Skill Y".to_string(),
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
                panel: None,
                skill: Some(crate::agent::manifest::schema::SkillDecl::One(
                    crate::agent::manifest::schema::SkillSection {
                        description: "自查清单".into(),
                        body: "逐文件检查。".into(),
                    },
                )),
                skills: None,
                tool: None,
            }),
            PathBuf::from("/agents/skill-y.toml"),
            true,
        );
        // v0.9.1 需求12：全局解析服务提示块——启用 [mcp] 插件才有，
        // 文案含两步走指引与前缀规则（v0.9.4 需求9 P2：动态发现文案）。
        {
            let block = render_hub_mcp_resolver_hint(&[&mcp_plugin]);
            assert!(block.contains("jishu-hub — MCP 解析服务"));
            assert!(block.contains("插件id__"));
            assert!(block.contains("hub_mcp_list"));
            assert!(block.contains("hub_mcp_call"));
            // 无 [mcp] 插件 → 空块。
            let none = render_hub_mcp_resolver_hint(&[&skill_plugin]);
            assert!(none.is_empty());
            // 禁用的 [mcp] 插件 → 空块（与聚合 server 暴露范围一致）。
            let mut disabled_mcp = ToolPlugin::for_test(
                std::sync::Arc::new(AgentManifestFile {
                    schema: 1,
                    kind: ManifestKind::Tool,
                    info: InfoSection {
                        id: "mcp-off".to_string(),
                        display_name: "MCP Off".to_string(),
                        icon: String::new(),
                        install_hint: None,
                    },
                    probe: None,
                    transport: None,
                    config: None,
                    session: None,
                    capabilities: None,
                    pi_extension: None,
                    mcp: Some(crate::agent::manifest::schema::McpSection {
                        transport: Default::default(),
                        command: Some("npx".into()),
                        args: None,
                        env: None,
                        url: None,
                        vision_tools: None,
                        headers: None,
                    }),
                    panel: None,
                    skill: None,
                    skills: None,
                    tool: None,
                }),
                PathBuf::from("/agents/mcp-off.toml"),
                false,
            );
            disabled_mcp.enabled = false;
            assert!(render_hub_mcp_resolver_hint(&[&disabled_mcp]).is_empty());
        }

        let block = render_tool_block(&[&mcp_plugin, &skill_plugin]);
        assert!(block.contains("## mcp-x — MCP 服务"));
        assert!(block.contains("mcp-x__"));
        assert!(block.contains("## skill-y — Skill"));
        assert!(block.contains("自查清单"));
        assert!(!block.contains("## skill-y — d")); // skill-only 无 [tool] 小节
                                                    // 快照提取：两 id 均入列。
        let (_, ids) = crate::agent::internal_prompts::extract_tool_snapshot(&block);
        assert!(ids.contains(&"mcp-x".to_string()));
        assert!(ids.contains(&"skill-y".to_string()));
    }

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
        map.insert("__new_session__".to_string(), vec!["tool-a".to_string()]);
        map.insert("target-session".to_string(), vec!["tool-b".to_string()]);
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

}
