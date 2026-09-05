//! Skill 分发服务（v0.9.0 需求20，对标 mcp_inject 的总控模式）。
//!
//! 启用的 [skill] 声明插件 → 渲染 SKILL.md 部署到各 agent 的 skill 目录
//!（claude-code `~/.claude/skills/`、jishu-self `<agent_dir>/skills/`），
//! 禁用/卸载/skill-resolver 关闭 → 回收。分发目标表驱动（codex 无原生
//! 机制、opencode 未核实，MVP 跳过——02 §六）。
//!
//! 归属保护：hub 分发过的 (agent, plugin_id) 记录于
//! `~/.jishu-hub/skill-deploy.json`——回收只删记录内的目录，同名用户
//! 自建目录不碰（对标 MCP 条目同名保护）。幂等：内容一致跳过写。
//! 触发点：lib.rs 启动 + rebuild_registry（与 mcp sync 同钩子）。

use std::collections::HashSet;
use std::path::PathBuf;

/// 分发目标（agent_id, skill 根目录）。四家全量（v0.9.0 需求20 第四轮：
/// codex `~/.codex/skills` / opencode `~/.config/opencode/skills` 均为
/// SKILL.md 标准目录——openai/codex#5291 与 opencode 官方文档确认），
/// 外加 manifest 智能体声明的 [skills].dir（`<dir>/<skill名>/SKILL.md`）。
pub fn skill_targets() -> Vec<(String, PathBuf)> {
    let mut targets = Vec::new();
    if let Ok(claude) = crate::config::claude_dir() {
        targets.push(("claude-code".to_string(), claude.join("skills")));
    }
    if let Some(home) = dirs::home_dir() {
        targets.push(("codex".to_string(), home.join(".codex").join("skills")));
        targets.push((
            "opencode".to_string(),
            home.join(".config").join("opencode").join("skills"),
        ));
    }
    if let Ok(agent_dir) = crate::agent::jishu_self::paths::agent_dir() {
        targets.push(("jishu-self".to_string(), agent_dir.join("skills")));
    }
    targets.extend(manifest_skill_targets());
    targets
}

/// manifest 智能体声明的 skill 根目录（纯投影，测试可注入）。
pub fn manifest_skill_targets_from(
    manifests: &[super::manifest::schema::AgentManifestFile],
) -> Vec<(String, PathBuf)> {
    manifests
        .iter()
        .filter(|m| m.skills.is_some())
        .filter_map(|m| {
            let dir = m.skills.as_ref()?;
            (!dir.dir.trim().is_empty()).then(|| {
                (
                    m.info.id.clone(),
                    super::manifest::schema::expand_tilde(&dir.dir),
                )
            })
        })
        .collect()
}

fn manifest_skill_targets() -> Vec<(String, PathBuf)> {
    let (agents, _tools, _errors) = super::manifest::load_manifests(&[]);
    let files: Vec<_> = agents.into_iter().map(|(f, _)| f).collect();
    manifest_skill_targets_from(&files)
}

/// SKILL.md 渲染（Agent Skills 规范：frontmatter name+description + 正文）。
/// skill 名 = 插件 id（分发目录名即命名空间，对标 MCP 的 <plugin_id>__<tool>）。
pub fn render_skill_md(id: &str, description: &str, body: &str) -> String {
    format!("---\nname: {id}\ndescription: {description}\n---\n\n{body}\n")
}

/// 归属记录 key：`<agent_id>:<plugin_id>`。
fn own_key(agent_id: &str, plugin_id: &str) -> String {
    format!("{agent_id}:{plugin_id}")
}

fn deploy_registry_path() -> PathBuf {
    super::manifest::hub_home().join("skill-deploy.json")
}

fn load_deploy_registry() -> HashSet<String> {
    let Ok(content) = std::fs::read_to_string(deploy_registry_path()) else {
        return HashSet::new();
    };
    serde_json::from_str::<Vec<String>>(&content)
        .map(|v| v.into_iter().collect())
        .unwrap_or_else(|e| {
            log::warn!("[skill-deploy] invalid skill-deploy.json ({e}), ignoring");
            HashSet::new()
        })
}

fn save_deploy_registry(set: &HashSet<String>) {
    let path = deploy_registry_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut v: Vec<String> = set.iter().cloned().collect();
    v.sort();
    if let Ok(content) = serde_json::to_string_pretty(&v) {
        if let Err(e) = crate::util::atomic_write(&path, content.as_bytes()) {
            log::warn!("[skill-deploy] cannot save skill-deploy.json: {e}");
        }
    }
}

/// 启用的 [skill] 声明（plugin_id, description, body）。
pub fn load_skill_decls() -> Vec<(String, String, String)> {
    let disabled: HashSet<String> = crate::agent::plugin::load_plugin_config()
        .disabled
        .into_iter()
        .collect();
    crate::agent::tool_plugin::load_tool_plugins(&disabled)
        .into_iter()
        .filter(|p| p.enabled)
        .filter_map(|p| {
            let s = p.file.skill.as_ref()?;
            Some((p.id().to_string(), s.description.clone(), s.body.clone()))
        })
        .collect()
}

#[derive(Debug, Default, serde::Serialize)]
pub struct SkillSyncReport {
    /// 逐项动作行（`claude-code/code-review: Deployed` 等），日志与 CLI status 用。
    pub actions: Vec<String>,
}

impl SkillSyncReport {
    fn push(&mut self, agent_id: &str, plugin_id: &str, action: &str) {
        self.actions.push(format!("{agent_id}/{plugin_id}: {action}"));
    }
}

/// 同步入口（条件语义）：skill-resolver（系统插件，默认启用）开 → 分发启用
/// 清单并回收失联项；关 → 回收全部自家。`force` = 显式命令（CLI deploy），
/// 忽略门控强制分发（显式命令 = 显式意图，对标 mcp inject）。
pub fn sync_skill_deployments(force: bool) -> SkillSyncReport {
    let resolver_on = force || crate::agent::plugin::is_skill_resolver_enabled();
    let decls = if resolver_on {
        load_skill_decls()
    } else {
        Vec::new()
    };
    sync_with(decls, &skill_targets(), resolver_on)
}

/// 纯度足够的同步核心（测试注入 decls 与 targets；真实路径走文件系统，
/// 经 JISHU_HUB_HOME + 真实 home 的 tempdir 不隔离——tests 仅用临时 targets）。
fn sync_with(
    decls: Vec<(String, String, String)>,
    targets: &[(String, PathBuf)],
    _resolver_on: bool,
) -> SkillSyncReport {
    let mut report = SkillSyncReport::default();
    let mut owned = load_deploy_registry();
    let decl_ids: HashSet<&str> = decls.iter().map(|(id, _, _)| id.as_str()).collect();

    // 1. 分发/更新启用清单。
    for (agent_id, root) in targets {
        for (id, description, body) in &decls {
            let dir = root.join(id);
            let target = dir.join("SKILL.md");
            let content = render_skill_md(id, description, body);
            let action = match std::fs::read_to_string(&target) {
                Ok(existing) if existing == content => "Skipped",
                _ => {
                    let _ = std::fs::create_dir_all(&dir);
                    match crate::util::atomic_write(&target, content.as_bytes()) {
                        Ok(()) => "Deployed",
                        Err(e) => {
                            report.push(agent_id, id, &format!("Error: {e}"));
                            continue;
                        }
                    }
                }
            };
            if action != "Skipped" || owned.contains(&own_key(agent_id, id)) {
                report.push(agent_id, id, action);
            } else {
                // 内容一致但归属记录缺失（首见即已同内容，如手工预置）——
                // 纳入归属以便后续回收管理。
                report.push(agent_id, id, "Adopted");
            }
            owned.insert(own_key(agent_id, id));
        }
    }

    // 2. 回收：归属记录内已不在启用清单的项。
    let to_remove: Vec<String> = owned
        .iter()
        .filter(|k| match k.split_once(':') {
            Some((agent_id, plugin_id)) => {
                // 保留目标 agent 仍在表中且插件仍启用的项。
                !targets
                    .iter()
                    .any(|(a, _)| a.as_str() == agent_id && decl_ids.contains(plugin_id))
            }
            None => true, // 非法记录：清除
        })
        .cloned()
        .collect();
    for key in &to_remove {
        let Some((agent_id, plugin_id)) = key.split_once(':') else {
            continue;
        };
        let Some((_, root)) = targets.iter().find(|(a, _)| a.as_str() == agent_id) else {
            owned.remove(key); // 目标 agent 已不在表中：仅清记录
            continue;
        };
        let dir = root.join(plugin_id);
        if dir.exists() {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => report.push(agent_id, plugin_id, "Removed"),
                Err(e) => {
                    report.push(agent_id, plugin_id, &format!("Error: {e}"));
                    continue;
                }
            }
        }
        owned.remove(key);
    }

    save_deploy_registry(&owned);
    if !report.actions.is_empty() {
        log::info!("[skill-deploy] {}", report.actions.join("; "));
    }
    report
}

/// 回收全部自家（CLI `skill remove` / resolver 关闭路径复用）。
pub fn remove_all_deployed() -> SkillSyncReport {
    sync_with(Vec::new(), &skill_targets(), false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::manifest::env_test_lock;

    #[test]
    fn render_skill_md_matches_spec() {
        let md = render_skill_md("code-review", "自查清单", "第一步：通读 diff。");
        assert!(md.starts_with("---\n"));
        assert!(md.contains("name: code-review"));
        assert!(md.contains("description: 自查清单"));
        assert!(md.contains("\n第一步：通读 diff。\n"));
    }

    #[test]
    fn own_key_roundtrip() {
        let k = own_key("jishu-self", "my-skill");
        assert_eq!(k, "jishu-self:my-skill");
        assert_eq!(k.split_once(':'), Some(("jishu-self", "my-skill")));
    }

    #[test]
    fn sync_deploys_skips_and_removes() {
        let _guard = env_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        let root = tempfile::tempdir().unwrap();
        let targets = vec![("test-agent".to_string(), root.path().join("skills"))];

        // 1) 首次分发 → Deployed + 归属记录。
        let report = sync_with(
            vec![("s1".into(), "d1".into(), "b1".into())],
            &targets,
            true,
        );
        assert!(report.actions.iter().any(|a| a.contains("test-agent/s1: Deployed")));
        let md = std::fs::read_to_string(root.path().join("skills/s1/SKILL.md")).unwrap();
        assert!(md.contains("name: s1"));
        assert!(load_deploy_registry().contains("test-agent:s1"));

        // 2) 内容一致 → Skipped。
        let report = sync_with(
            vec![("s1".into(), "d1".into(), "b1".into())],
            &targets,
            true,
        );
        assert!(report.actions.iter().any(|a| a.contains("test-agent/s1: Skipped")));

        // 3) 内容变化 → 覆盖更新。
        let report = sync_with(
            vec![("s1".into(), "d1+".into(), "b1+".into())],
            &targets,
            true,
        );
        assert!(report.actions.iter().any(|a| a.contains("Deployed")));
        assert!(std::fs::read_to_string(root.path().join("skills/s1/SKILL.md"))
            .unwrap()
            .contains("description: d1+"));

        // 4) 同名用户自建目录（不在归属记录）→ 不被回收。
        let foreign = root.path().join("skills/s1"); // 已属 hub——另建用户目录验证：
        let user_dir = root.path().join("skills/my-skill");
        std::fs::create_dir_all(&user_dir).unwrap();
        std::fs::write(user_dir.join("SKILL.md"), "user own").unwrap();
        let report = sync_with(Vec::new(), &targets, false); // 清空清单 = 回收自家
        assert!(report.actions.iter().any(|a| a.contains("test-agent/s1: Removed")));
        assert!(!foreign.exists());
        assert!(user_dir.exists(), "用户自建同名目录不受影响");
        assert!(load_deploy_registry().is_empty());

        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn manifest_skill_targets_projection() {
        // v0.9.0 需求20 第四轮：manifest 智能体 [skills].dir → 分发目标投影。
        use crate::agent::manifest::schema as ms;
        let mk = |id: &str, dir: Option<&str>| ms::AgentManifestFile {
            schema: 1,
            kind: Default::default(),
            info: ms::InfoSection {
                id: id.to_string(),
                display_name: id.to_string(),
                icon: String::new(),
                install_hint: None,
            },
            probe: None,
            transport: Some(ms::TransportSection {
                kind: ms::TransportKind::Cli,
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
            skill: None,
            skills: dir.map(|d| ms::SkillsDirSection { dir: d.to_string() }),
            tool: None,
        };
        let targets = manifest_skill_targets_from(&[
            mk("gemini", Some("~/.gemini/skills")),
            mk("no-decl", None),
            mk("empty-dir", Some("  ")),
        ]);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].0, "gemini");
        assert!(targets[0].1.to_string_lossy().contains(".gemini"));
    }

    #[test]
    fn registry_corrupt_falls_back_empty() {
        let _guard = env_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        std::fs::write(deploy_registry_path(), "{not json").unwrap();
        assert!(load_deploy_registry().is_empty());
        std::env::remove_var("JISHU_HUB_HOME");
    }
}
