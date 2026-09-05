//! 统一插件模型（v0.8.1 需求2）：内建 Rust 实现 agent 与 manifest 声明式
//! agent 的统一装载层。
//!
//! 「插件」= agent 的装载单元。内建插件（claude-code / codex / opencode /
//! jishu-self）随 hub 分发，经 [`builtin_plugin_specs`] 工厂清单注入——
//! AgentRegistry::new() 不再硬编码 insert；manifest 插件（需求1 M2）自
//! `~/.jishu-hub/agents/*.toml` 装载。两类插件同一描述符
//! （[`PluginDescriptor`]）、同一启停存储（`plugins.json`）。
//!
//! 命名边界：本模块的 `PluginKind::Builtin`（装载来源）与 trait
//! `AgentManifest::is_builtin()`（核心引擎托管标志，仅 jishu-self）是两个
//! 概念，后者驱动 UI 置顶与任务模式，不得混用。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::traits::AgentPlugin;

/// 插件来源分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginKind {
    /// 内建插件：Rust 实现，随 hub 分发（版本 = 应用版本）。
    Builtin,
    /// manifest 智能体插件：TOML 声明，来自 ~/.jishu-hub/agents/。
    Manifest,
    /// 工具插件（v0.8.1 需求7）：CLI 能力单元，kind = "tool" 的 manifest，
    /// 不进 AgentRegistry，经会话 + 菜单注入智能体上下文。
    Tool,
}

/// 一个已装载插件的描述（UI / CLI 插件管理面的数据源）。
#[derive(Debug, Clone, Serialize)]
pub struct PluginDescriptor {
    pub id: String,
    pub display_name: String,
    pub kind: PluginKind,
    /// Builtin = 应用版本；Manifest = probe 探测版本（未探测为 None）。
    pub version: Option<String>,
    /// Manifest 插件的来源文件路径；Builtin 为 None。
    pub source_path: Option<String>,
    /// 核心引擎（jishu-self）：不可禁用/删除。
    pub core: bool,
    /// 当前是否装载（false = 用户禁用，registry 无此 agent；数据保留）。
    pub enabled: bool,
    /// 声明了 [mcp] 段（v0.9.0 需求1：hub 聚合 MCP server 的工具来源）。
    pub has_mcp: bool,
    /// 声明了 [panel] 段（v0.9.0 需求8：声明式面板）。
    pub has_panel: bool,
    /// [panel] 声明详情（has_panel 时非 None；前端面板 Dialog 数据源）。
    pub panel: Option<PanelDecl>,
    /// 系统插件（v0.9.0 需求1 二期）：hub 随包分发、启动幂等重部署——
    /// 不可卸载/编辑（删了也会回来，编辑会被重部署覆盖），可禁用。
    pub system: bool,
}

/// [panel] 声明的 UI 投影（v0.9.0 需求8）。
#[derive(Debug, Clone, Serialize)]
pub struct PanelDecl {
    pub title: String,
    pub items: Vec<PanelDeclItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PanelDeclItem {
    pub label: String,
    pub command: String,
}

/// 插件启停配置（`~/.jishu-hub/plugins.json`，hub state 文件同款模式）。
/// 只记 disabled 集合——默认启用，新增 manifest 插件零配置自动生效。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginConfig {
    #[serde(default)]
    pub disabled: Vec<String>,
    #[serde(default)]
    pub updated_at: i64,
}

/// 核心引擎 id 清单（恒装载，禁用请求双层拒绝的依据）。
pub const CORE_PLUGIN_IDS: [&str; 1] = [super::JISHU_SELF_AGENT_ID];

/// 系统插件 id 清单（v0.9.0 需求1 二期）：hub 随包分发、启动幂等重部署——
/// 卸载/编辑无意义（下次启动即恢复），plugin_remove 拒绝、前端隐藏入口；
/// 可禁用（mcp-resolver 禁用 = MCP 服务总开关，见 mcp_inject）。
pub const SYSTEM_PLUGIN_IDS: [&str; 3] = ["mcp-resolver", "task-requirements", "task-plan"];

/// 系统插件判定。
pub fn is_system_plugin(id: &str) -> bool {
    SYSTEM_PLUGIN_IDS.contains(&id)
}

/// MCP 解析器启用态（注入门控，mcp_inject::sync_hub_mcp_entries）：
/// plugins.json disabled 集不含 mcp-resolver 即启用（默认启用——disabled
/// 为 opt-in 存储，全新环境零配置即在位）。
pub fn is_mcp_resolver_enabled() -> bool {
    !load_plugin_config().disabled.iter().any(|x| x == "mcp-resolver")
}

pub fn plugin_config_path() -> PathBuf {
    super::manifest::hub_home().join("plugins.json")
}

/// 读取启停配置；文件缺失/损坏 → 全启用（= 插件化之前的行为，安全方向）。
pub fn load_plugin_config() -> PluginConfig {
    let Ok(content) = std::fs::read_to_string(plugin_config_path()) else {
        return PluginConfig::default();
    };
    match serde_json::from_str(&content) {
        Ok(config) => config,
        Err(e) => {
            log::warn!(
                "[plugin] invalid plugins.json ({}), falling back to all-enabled",
                e
            );
            PluginConfig::default()
        }
    }
}

/// 写启停配置（写失败 log 降级——下次写或重启时自愈）。
pub fn save_plugin_config(config: &PluginConfig) -> Result<(), String> {
    let path = plugin_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    crate::util::atomic_write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

/// 已知插件 id 集合（内置 + 已安装 manifest），启停校验用。
fn known_plugin_ids() -> HashSet<String> {
    let mut ids: HashSet<String> = builtin_plugin_specs()
        .iter()
        .map(|(factory, _)| factory().info().id)
        .collect();
    let (agents, tools, _errors) = super::manifest::load_manifests(&[]);
    for (file, _path) in agents.into_iter().chain(tools) {
        ids.insert(file.info.id);
    }
    ids
}

/// 设置插件启停并落盘。core 插件拒绝；未知 id 拒绝（配置漂移防写入）。
pub fn set_plugin_enabled(id: &str, enabled: bool) -> Result<PluginConfig, String> {
    if CORE_PLUGIN_IDS.contains(&id) {
        return Err(format!(
            "Plugin {id} is the core engine and cannot be disabled"
        ));
    }
    let known = known_plugin_ids();
    if !known.contains(id) {
        return Err(format!("Unknown plugin: {id}"));
    }
    let mut config = load_plugin_config();
    if enabled {
        config.disabled.retain(|x| x != id);
    } else if !config.disabled.iter().any(|x| x == id) {
        config.disabled.push(id.to_string());
    }
    config.updated_at = crate::util::now_ms();
    save_plugin_config(&config)?;
    Ok(config)
}

/// 安装一个 manifest 插件：id 冲突检查（内置 + 已安装）→ 写入 agents 目录。
/// 校验（schema/validate）由调用方先行完成——CLI `plugins add`（原始 TOML
/// 内容）与 GUI `plugin_create`（表单 JSON → 后端生成 TOML）共用此落盘通道。
/// 返回 (插件 id, 写入路径)。
pub fn install_manifest_file(
    file: &super::manifest::schema::AgentManifestFile,
    content_toml: &str,
) -> Result<(String, PathBuf), String> {
    let builtin_ids: Vec<String> = builtin_plugin_specs()
        .iter()
        .map(|(factory, _)| factory().info().id)
        .collect();
    let (installed_agents, installed_tools, _errors) =
        super::manifest::load_manifests(&builtin_ids);
    if builtin_ids.contains(&file.info.id)
        || installed_agents
            .iter()
            .chain(installed_tools.iter())
            .any(|(f, _)| f.info.id == file.info.id)
    {
        return Err(format!(
            "agent id {:?} conflicts with a builtin or already-installed plugin",
            file.info.id
        ));
    }
    let target = super::manifest::manifest_dir().join(format!("{}.toml", file.info.id));
    if target.exists() {
        return Err(format!(
            "target file already exists: {} (remove it first)",
            target.display()
        ));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // M6：原子写（与 plugin_update 一致）——修前裸 fs::write 半写文件可被
    // 装载管线读到。
    crate::util::atomic_write(&target, content_toml.as_bytes()).map_err(|e| e.to_string())?;
    log::info!(
        "[plugin] installed manifest plugin {} → {}",
        file.info.id,
        target.display()
    );
    Ok((file.info.id.clone(), target))
}

/// 内建插件工厂：`(工厂, 是否核心引擎)`。装载顺序稳定 = 插件化之前的
/// insert 顺序（claude-code → codex → opencode → jishu-self）。
pub type PluginFactory = fn() -> Box<dyn AgentPlugin + Send + Sync>;

/// 内建自适应插件清单（v0.8.1 需求10）：hub 内嵌 TOML（含 [pi_extension]
/// 与 [tool] 双段），启动时部署到 ~/.jishu-hub/agents/ 与 pi extensions 目录。
/// 这些是 hub 分发的能力插件——与用户自建 manifest 同一装载管线，但不可卸载。
pub fn builtin_adaptive_plugins() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "task-requirements",
            include_str!("../../resources/plugins/task-requirements/plugin.toml"),
        ),
        (
            "task-plan",
            include_str!("../../resources/plugins/task-plan/plugin.toml"),
        ),
    ]
}

/// MCP 解析器系统插件（v0.9.0 需求1 二期）：聚合 server（jishu-cli mcp
/// serve）的管理面实体——默认安装+启用、可禁用（= MCP 服务总开关）、
/// 不可卸载。panel-only（无 [tool]/[mcp]——[mcp] 会自指）：面板命令在部署
/// 时烘焙 jishu-cli 绝对路径（TOML 转义由 toml::Value 承担；路径变化时
/// 内容比较不齐即重写）。与 task-* 静态内嵌不同，本 manifest 为生成式。
pub fn resolver_plugin_toml() -> String {
    let cli = crate::agent::jishu_self::resolve_jishu_cli_binary()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "jishu-cli".to_string());
    let command = format!("\"{cli}\" mcp status");
    format!(
        "schema = 1\n\
         kind = \"tool\"\n\
         \n\
         [info]\n\
         id = \"mcp-resolver\"\n\
         display_name = \"MCP 解析器\"\n\
         icon = \"blocks\"\n\
         \n\
         [panel]\n\
         title = \"MCP 服务状态\"\n\
         \n\
         [[panel.items]]\n\
         label = \"聚合服务与插件清单\"\n\
         command = {}\n",
        toml::Value::String(command)
    )
}

/// 部署内建自适应插件与 MCP 解析器（幂等——文件已存在且内容一致则跳过）。
/// 仅写 manifest TOML 到 agents 目录（与用户自建走同一装载管线）；
/// pi 扩展入口文件由 task_plan.rs 的 conductor 部署管线管理（v1 过渡：
/// conductor 仍为单一 TS 文件，插件 TOML 引用其函数名的入口约定在 v2 拆分）。
pub fn ensure_builtin_adaptive_plugins() {
    let dir = super::manifest::manifest_dir();
    let _ = std::fs::create_dir_all(&dir);
    let statics = builtin_adaptive_plugins();
    for (id, toml) in statics
        .into_iter()
        .map(|(id, t)| (id.to_string(), t.to_string()))
        .chain(std::iter::once((
            "mcp-resolver".to_string(),
            resolver_plugin_toml(),
        )))
    {
        let target = dir.join(format!("{id}.toml"));
        let needs_write = match std::fs::read_to_string(&target) {
            Ok(existing) => existing != toml,
            Err(_) => true,
        };
        if needs_write {
            if let Err(e) = std::fs::write(&target, toml) {
                log::warn!("[plugin] cannot deploy builtin system plugin {id}: {e}");
            }
        }
    }
}

pub fn builtin_plugin_specs() -> Vec<(PluginFactory, bool)> {
    vec![
        (
            || Box::new(super::ClaudeCodeAgent::new()) as Box<dyn AgentPlugin + Send + Sync>,
            false,
        ),
        (
            || {
                Box::new(super::adapters::codex::CodexAdapter::new())
                    as Box<dyn AgentPlugin + Send + Sync>
            },
            false,
        ),
        (
            || {
                Box::new(super::adapters::opencode::OpencodeAdapter::new())
                    as Box<dyn AgentPlugin + Send + Sync>
            },
            false,
        ),
        (
            || {
                Box::new(super::jishu_self::JishuSelfAgent::new())
                    as Box<dyn AgentPlugin + Send + Sync>
            },
            true,
        ),
    ]
}

/// 装配核心（纯函数，可测）：内建插件 + manifest 插件 + 禁用集合 →
/// (agents 表, 插件描述符列表)。无禁用输入时产出与插件化之前的
/// 硬编码装载逐项等价（行为不变的实现保证）。
pub fn assemble(
    builtins: Vec<(Box<dyn AgentPlugin + Send + Sync>, bool)>,
    manifests: Vec<(Arc<super::manifest::schema::AgentManifestFile>, PathBuf)>,
    disabled: &HashSet<String>,
) -> (
    HashMap<String, Box<dyn AgentPlugin + Send + Sync>>,
    Vec<PluginDescriptor>,
) {
    let mut agents: HashMap<String, Box<dyn AgentPlugin + Send + Sync>> = HashMap::new();
    let mut plugins = Vec::new();

    for (plugin, core) in builtins {
        let info = plugin.info();
        let id = info.id.clone();
        // core 恒装载（手工改配置文件也无效——双保险，02 §5.3）。
        let enabled = core || !disabled.contains(&id);
        if enabled {
            agents.insert(id.clone(), plugin);
        }
        plugins.push(PluginDescriptor {
            id: id.clone(),
            display_name: info.display_name,
            kind: PluginKind::Builtin,
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            source_path: None,
            core,
            enabled,
            has_mcp: false,
            has_panel: false,
            panel: None,
            system: false,
        });
    }

    for (file, path) in manifests {
        let id = file.info.id.clone();
        let enabled = !disabled.contains(&id);
        if enabled {
            agents.insert(
                id.clone(),
                Box::new(super::manifest::agent::ManifestAgent::new(file.clone())),
            );
        }
        plugins.push(PluginDescriptor {
            id: id.clone(),
            display_name: file.info.display_name.clone(),
            kind: PluginKind::Manifest,
            // 版本在 AgentRegistry::list_plugins 里经 health_cache 回填
            //（assemble 不做 IO）。
            version: None,
            source_path: Some(path.to_string_lossy().to_string()),
            core: false,
            enabled,
            has_mcp: false,
            has_panel: false,
            panel: None,
            system: false,
        });
    }

    (agents, plugins)
}

/// 工具插件 → 描述符（plugin_list 合并渲染用）。
pub fn tool_descriptor(plugin: &super::tool_plugin::ToolPlugin) -> PluginDescriptor {
    PluginDescriptor {
        id: plugin.file.info.id.clone(),
        display_name: plugin.file.info.display_name.clone(),
        kind: PluginKind::Tool,
        version: None,
        source_path: Some(plugin.source_path.to_string_lossy().to_string()),
        core: false,
        enabled: plugin.enabled,
        has_mcp: plugin.file.mcp.is_some(),
        has_panel: plugin.file.panel.is_some(),
        panel: plugin.file.panel.as_ref().map(|p| PanelDecl {
            title: p.title.clone(),
            items: p
                .items
                .iter()
                .map(|i| PanelDeclItem {
                    label: i.label.clone(),
                    command: i.command.clone(),
                })
                .collect(),
        }),
        system: is_system_plugin(&plugin.file.info.id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // assemble 用假插件测形状与过滤（真 adapter 的行为等价由既有 registry
    // 测试锁定）；plugins.json 读写经 JISHU_HUB_HOME + tempdir 隔离。

    struct FakeAgent {
        id: &'static str,
        name: &'static str,
    }
    impl super::super::traits::AgentManifest for FakeAgent {
        fn info(&self) -> super::super::AgentInfo {
            super::super::AgentInfo {
                id: self.id.to_string(),
                display_name: self.name.to_string(),
                version: "?".to_string(),
                icon: "bot".to_string(),
                logo_path: None,
                enabled: true,
            }
        }
    }
    impl super::super::traits::TransportAdapter for FakeAgent {
        fn transport_surface(&self) -> super::super::TransportSurface {
            super::super::TransportSurface::Cli
        }
        fn build_chat_command(&self, _args: super::super::ChatRequest) -> tokio::process::Command {
            tokio::process::Command::new("fake")
        }
    }
    impl super::super::traits::ConfigAdapter for FakeAgent {
        fn load_config(&self) -> Result<serde_json::Value, String> {
            Ok(serde_json::json!({}))
        }
        fn save_config(&self, _: &serde_json::Value) -> Result<(), String> {
            Ok(())
        }
    }
    impl super::super::traits::SessionAdapter for FakeAgent {
        fn list_sessions(&self, _: &str) -> Result<Vec<crate::session::Session>, String> {
            Ok(vec![])
        }
        fn get_session_messages(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Vec<crate::session::Message>, String> {
            Ok(vec![])
        }
    }
    impl super::super::traits::TerminalAdapter for FakeAgent {
        fn open_in_terminal(
            &self,
            _: &str,
            _: Option<&str>,
        ) -> Result<u32, Box<dyn std::error::Error>> {
            unimplemented!()
        }
        fn open_in_terminal_with_command(
            &self,
            _: &str,
            _: &str,
        ) -> Result<u32, Box<dyn std::error::Error>> {
            unimplemented!()
        }
        fn build_resume_command(&self, _: &str) -> String {
            String::new()
        }
    }
    impl super::super::traits::ProjectAdapter for FakeAgent {
        fn scan_projects(&self) -> Vec<crate::project::Project> {
            vec![]
        }
        fn add_project(&self, _: &str) -> Option<crate::project::Project> {
            None
        }
        fn decode_project_path(&self, _: &str) -> String {
            String::new()
        }
        fn encode_project_path(&self, _: &str) -> String {
            String::new()
        }
        fn get_level1_dir(&self, _: &str) -> Option<String> {
            None
        }
        fn init_project(&self, _: &str) -> Result<bool, String> {
            Ok(false)
        }
        fn load_project_settings(
            &self,
            _: &str,
        ) -> Result<crate::project_config::ProjectSettings, String> {
            Err("Not supported".to_string())
        }
        fn load_project_settings_local(
            &self,
            _: &str,
        ) -> Result<crate::project_config::ProjectSettings, String> {
            Err("Not supported".to_string())
        }
        fn save_project_settings(
            &self,
            _: &str,
            _: &crate::project_config::ProjectSettings,
        ) -> Result<(), String> {
            Err("Not supported".to_string())
        }
        fn save_project_settings_local(
            &self,
            _: &str,
            _: &crate::project_config::ProjectSettings,
        ) -> Result<(), String> {
            Err("Not supported".to_string())
        }
    }
    impl super::super::traits::EventNormalizer for FakeAgent {}

    fn fake(id: &'static str, core: bool) -> (Box<dyn AgentPlugin + Send + Sync>, bool) {
        (Box::new(FakeAgent { id, name: id }), core)
    }

    fn manifest_file(id: &str) -> Arc<super::super::manifest::schema::AgentManifestFile> {
        Arc::new(super::super::manifest::schema::AgentManifestFile {
            schema: 1,
            kind: Default::default(),
            info: super::super::manifest::schema::InfoSection {
                id: id.to_string(),
                display_name: format!("Manifest {id}"),
                icon: String::new(),
                install_hint: None,
            },
            probe: None,
            transport: Some(super::super::manifest::schema::TransportSection {
                kind: super::super::manifest::schema::TransportKind::Cli,
                chat_command: Some(vec!["x".into(), "{prompt}".into()]),
                acp_command: None,
                cwd: None,
                pipe_stdin: false,
                abort_bytes: None,
            }),
            config: None,
            session: None,
            capabilities: None,
            pi_extension: None,
            mcp: None,
            panel: None,
            tool: None,
        })
    }

    #[test]
    fn assemble_equivalent_to_legacy_when_nothing_disabled() {
        let (agents, plugins) = assemble(
            vec![fake("claude-code", false), fake("jishu-self", true)],
            vec![(manifest_file("demo"), PathBuf::from("/agents/demo.toml"))],
            &HashSet::new(),
        );
        assert_eq!(agents.len(), 3);
        assert!(agents.contains_key("claude-code"));
        assert!(agents.contains_key("jishu-self"));
        assert!(agents.contains_key("demo"));
        assert!(plugins.iter().all(|p| p.enabled));
        let core = plugins.iter().find(|p| p.id == "jishu-self").unwrap();
        assert!(core.core);
        assert_eq!(core.kind, PluginKind::Builtin);
        assert_eq!(core.version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn disabled_builtin_not_loaded_but_described() {
        let mut disabled = HashSet::new();
        disabled.insert("codex".to_string());
        let (agents, plugins) = assemble(
            vec![fake("codex", false), fake("jishu-self", true)],
            vec![],
            &disabled,
        );
        assert!(!agents.contains_key("codex"));
        let codex = plugins.iter().find(|p| p.id == "codex").unwrap();
        assert!(!codex.enabled);
        assert_eq!(codex.kind, PluginKind::Builtin);
    }

    #[test]
    fn core_plugin_always_loaded_even_if_disabled_in_config() {
        let mut disabled = HashSet::new();
        disabled.insert("jishu-self".to_string());
        let (agents, plugins) = assemble(vec![fake("jishu-self", true)], vec![], &disabled);
        assert!(
            agents.contains_key("jishu-self"),
            "core ignores disabled set"
        );
        let core = plugins.iter().find(|p| p.id == "jishu-self").unwrap();
        assert!(core.enabled);
    }

    #[test]
    fn disabled_manifest_kept_in_descriptors_with_path() {
        let mut disabled = HashSet::new();
        disabled.insert("demo".to_string());
        let (agents, plugins) = assemble(
            vec![],
            vec![(manifest_file("demo"), PathBuf::from("/agents/demo.toml"))],
            &disabled,
        );
        assert!(agents.is_empty());
        let demo = plugins.iter().find(|p| p.id == "demo").unwrap();
        assert!(!demo.enabled);
        assert_eq!(demo.kind, PluginKind::Manifest);
        assert_eq!(demo.source_path.as_deref(), Some("/agents/demo.toml"));
        assert!(!demo.core);
    }

    use crate::agent::manifest::env_test_lock;

    #[test]
    fn resolver_plugin_toml_parses_and_system_guards() {
        // v0.9.0 需求1 二期：解析器 manifest 生成合法（panel-only 工具插件）
        // + 系统插件判定。测试进程旁通常无 jishu-cli → 命令回退裸名，解析不受影响。
        let toml = resolver_plugin_toml();
        let file: super::super::manifest::schema::AgentManifestFile =
            toml::from_str(&toml).unwrap();
        assert!(file.validate().is_ok(), "resolver manifest must be valid");
        assert_eq!(file.info.id, "mcp-resolver");
        assert!(file.panel.is_some());
        assert!(file.mcp.is_none()); // 解析器是 server 本体，[mcp] 会自指
        assert!(file.tool.is_none());
        assert!(is_system_plugin("mcp-resolver"));
        assert!(is_system_plugin("task-requirements"));
        assert!(!is_system_plugin("user-tool"));
    }

    #[test]
    fn resolver_default_enabled_and_disable_gates_off() {
        let _guard = env_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        // 无 plugins.json → 默认启用。
        assert!(is_mcp_resolver_enabled());
        let mut cfg = load_plugin_config();
        cfg.disabled.push("mcp-resolver".to_string());
        save_plugin_config(&cfg).unwrap();
        assert!(!is_mcp_resolver_enabled());
        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn ensure_deploys_system_plugins_idempotent() {
        let _guard = env_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        ensure_builtin_adaptive_plugins();
        let dir = super::super::manifest::manifest_dir();
        for id in SYSTEM_PLUGIN_IDS {
            assert!(
                dir.join(format!("{id}.toml")).exists(),
                "{id} should be deployed"
            );
        }
        // 幂等：二次部署不报错、内容不变。
        let before = std::fs::read_to_string(dir.join("mcp-resolver.toml")).unwrap();
        ensure_builtin_adaptive_plugins();
        let after = std::fs::read_to_string(dir.join("mcp-resolver.toml")).unwrap();
        assert_eq!(before, after);
        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn plugin_config_roundtrip_and_set_enabled_guards() {
        let _guard = env_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        // set_plugin_enabled 依赖 known_plugin_ids → 会实例化真 adapter 并扫
        // manifest 目录（tempdir 下无 manifest）。claude-code 是已知内置。
        let config = set_plugin_enabled("claude-code", false).unwrap();
        assert!(config.disabled.contains(&"claude-code".to_string()));
        // 幂等重复 disable
        set_plugin_enabled("claude-code", false).unwrap();
        // core 拒绝
        assert!(set_plugin_enabled("jishu-self", false).is_err());
        // 未知 id 拒绝
        assert!(set_plugin_enabled("no-such", false).is_err());
        // enable 移除
        let config = set_plugin_enabled("claude-code", true).unwrap();
        assert!(!config.disabled.contains(&"claude-code".to_string()));
        // 落盘可读回
        assert_eq!(load_plugin_config().disabled.len(), 0);
        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn corrupted_config_falls_back_to_all_enabled() {
        let _guard = env_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        std::fs::write(plugin_config_path(), "{not json").unwrap();
        assert!(load_plugin_config().disabled.is_empty());
        std::env::remove_var("JISHU_HUB_HOME");
    }
}
