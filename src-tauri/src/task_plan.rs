use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const BUNDLED_TASK_PLAN_REGISTRY: &str = include_str!("../resources/task-plan/registry.json");

#[derive(Debug, Deserialize)]
struct TaskPlanRegistryManifest {
    #[serde(default)]
    skills: Vec<TaskPlanRegistryEntry>,
}

#[derive(Debug, Deserialize)]
struct TaskPlanRegistryEntry {
    id: String,
    source: InstallSource,
}

#[derive(Debug, Clone)]
struct BuiltinTaskPlanSkill {
    id: String,
    source: InstallSource,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum InstallSource {
    Bundled,
    GitSparse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskPlanSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: Option<String>,
    pub installed: bool,
    pub builtin: bool,
    pub installable: bool,
    pub valid: bool,
    pub error: Option<String>,
    pub content_bytes: u64,
    pub content_hash: String,
    #[serde(default)]
    pub workflow_hints: Option<String>,
    #[serde(default)]
    pub roles: Vec<TaskPlanRole>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskPlanRole {
    pub role_id: String,
    pub role_name: String,
    #[serde(default)]
    pub responsibilities: Vec<String>,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub can_edit_files: bool,
    #[serde(default)]
    pub can_run_commands: bool,
    #[serde(default)]
    pub can_receive_rework: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SkillManifest {
    #[serde(default)]
    workflow_hints: Option<String>,
    #[serde(default)]
    roles: Vec<RoleManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct RoleManifest {
    role_id: String,
    role_name: String,
    #[serde(default)]
    purpose: String,
    #[serde(default)]
    collaborate_with: Vec<String>,
    #[serde(default)]
    deliverables: Vec<String>,
    #[serde(default)]
    responsibilities: Vec<String>,
    #[serde(default)]
    acceptance: Vec<String>,
    #[serde(default)]
    can_edit_files: bool,
    #[serde(default)]
    can_run_commands: bool,
    #[serde(default = "default_receive_rework")]
    can_receive_rework: bool,
}

fn default_receive_rework() -> bool {
    true
}

fn jishu_agent_dir() -> Result<PathBuf, String> {
    crate::agent::jishu_self::paths::agent_dir().map_err(|e| e.to_string())
}

pub fn task_plan_dir() -> Result<PathBuf, String> {
    Ok(jishu_agent_dir()?.join("task-plan"))
}

fn builtin_skills_for_dir(dir: &Path) -> Result<Vec<BuiltinTaskPlanSkill>, String> {
    let user_registry = dir.join("registry.json");
    let content = if user_registry.exists() {
        std::fs::read_to_string(&user_registry).map_err(|err| err.to_string())?
    } else {
        BUNDLED_TASK_PLAN_REGISTRY.to_string()
    };
    let manifest: TaskPlanRegistryManifest = serde_json::from_str(&content)
        .map_err(|err| format!("Invalid task-plan registry: {err}"))?;
    Ok(manifest
        .skills
        .into_iter()
        .map(|entry| BuiltinTaskPlanSkill {
            id: entry.id,
            source: entry.source,
        })
        .collect())
}

// ── Pi 扩展自动注册（Hub setup hook 每次启动幂等确保）── // FORCE COMPILER TO RE-READ STATIC EMBEDDED FILE CHANGES V12
const CONDUCTOR_EXTENSION_TS: &str =
    include_str!("../resources/extensions/jishu-task-conductor.ts");
const CONDUCTOR_DISCUSS_SKILL: &str =
    include_str!("../resources/task-plan/jishu-conductor-dev/discuss.SKILL.md");
const CONDUCTOR_PLAN_SKILL: &str =
    include_str!("../resources/task-plan/jishu-conductor-dev/plan.SKILL.md");
const CONDUCTOR_EXECUTE_SKILL: &str =
    include_str!("../resources/task-plan/jishu-conductor-dev/execute.SKILL.md");
const REQUEST_USER_INPUT_EXTENSION_TS: &str =
    include_str!("../resources/extensions/request-user-input.ts");
const SESSION_CONTEXT_EXTENSION_TS: &str =
    include_str!("../resources/extensions/session-context.ts");

/// 部署内嵌扩展源到 `<agent_dir>/<rel_path>`，自动建父目录；内容相同则跳过写入。
fn deploy_extension_file(agent_dir: &Path, rel_path: &str, source: &str) {
    let target = agent_dir.join(rel_path);
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::read_to_string(&target).ok().as_deref() != Some(source) {
        let _ = std::fs::write(&target, source);
    }
}

/// 在 `settings.json` 的 `extensions` 数组幂等追加 `rel_path`。
/// settings.json 不存在 → 兜底创建（修复旧版静默跳过的隐患）；
/// 存在但 JSON 损坏 / 顶层非 object → 保守 return，不动用户文件。
fn register_extension_in_settings(agent_dir: &Path, rel_path: &str) {
    let settings_path = agent_dir.join("settings.json");
    let content = std::fs::read_to_string(&settings_path).unwrap_or_else(|_| "{}".to_string());
    let mut settings = match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(v) if v.is_object() => v,
        _ => return,
    };
    let exists = settings
        .get("extensions")
        .and_then(|v| v.as_array())
        .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(rel_path)));
    if exists {
        return;
    }
    match settings
        .get_mut("extensions")
        .and_then(|v| v.as_array_mut())
    {
        Some(arr) => arr.push(serde_json::Value::String(rel_path.to_string())),
        None => {
            settings["extensions"] = serde_json::json!([rel_path]);
        }
    }
    if let Ok(new_content) = serde_json::to_string_pretty(&settings) {
        let _ = std::fs::write(&settings_path, new_content);
    }
}

/// 自动注册 Conductor 扩展 + skill pack + settings.json extensions + 删除旧 skill。
/// 在 Hub setup hook 调用，每次启动自动确保。
pub fn ensure_conductor_extension() {
    let Ok(agent_dir) = jishu_agent_dir() else {
        return;
    };
    ensure_conductor_extension_in(&agent_dir);
}

fn ensure_conductor_extension_in(agent_dir: &Path) {
    const CONDUCTOR_EXT_REL: &str = "extensions/jishu-task-conductor.ts";

    // 1. 写扩展文件
    deploy_extension_file(agent_dir, CONDUCTOR_EXT_REL, CONDUCTOR_EXTENSION_TS);

    // 2. 写 skill pack
    let skill_dir = agent_dir.join("skills").join("jishu-conductor-dev");
    let _ = std::fs::create_dir_all(&skill_dir);
    let _ = std::fs::write(skill_dir.join("discuss.SKILL.md"), CONDUCTOR_DISCUSS_SKILL);
    let _ = std::fs::write(skill_dir.join("plan.SKILL.md"), CONDUCTOR_PLAN_SKILL);
    let _ = std::fs::write(skill_dir.join("execute.SKILL.md"), CONDUCTOR_EXECUTE_SKILL);

    // 3. 注册 settings.json extensions（幂等）
    register_extension_in_settings(agent_dir, CONDUCTOR_EXT_REL);

    // 4. 删除旧 skill（避免 agent 读旧 jishu-task-planner 干扰 Conductor）
    let old_skill = agent_dir.join("skills").join("jishu-task-planner");
    if old_skill.exists() {
        let _ = std::fs::remove_dir_all(&old_skill);
    }
}

/// 自动部署 `request_user_input` 扩展（conductor 的 discuss/plan 阶段依赖此工具）。
/// 在 Hub setup hook 调用，每次启动自动确保。
pub fn ensure_request_user_input_extension() {
    let Ok(agent_dir) = jishu_agent_dir() else {
        return;
    };
    ensure_request_user_input_extension_in(&agent_dir);
}

fn ensure_request_user_input_extension_in(agent_dir: &Path) {
    const RUI_EXT_REL: &str = "extensions/request-user-input.ts";
    deploy_extension_file(agent_dir, RUI_EXT_REL, REQUEST_USER_INPUT_EXTENSION_TS);
    register_extension_in_settings(agent_dir, RUI_EXT_REL);
}

/// 自动部署 `session-context` 扩展：把当前 session_id 注入 system prompt（每轮），
/// 供 conductor 将当前 Pi 会话关联到 TaskInstance，
/// 取代往 user message 拼提示词的旧做法（避免污染会话列表名/内容/搜索）。
pub fn ensure_session_context_extension() {
    let Ok(agent_dir) = jishu_agent_dir() else {
        return;
    };
    ensure_session_context_extension_in(&agent_dir);
}

fn ensure_session_context_extension_in(agent_dir: &Path) {
    const SC_EXT_REL: &str = "extensions/session-context.ts";
    deploy_extension_file(agent_dir, SC_EXT_REL, SESSION_CONTEXT_EXTENSION_TS);
    register_extension_in_settings(agent_dir, SC_EXT_REL);
}

pub fn read_installed_skill(dir: &Path, skill_id: &str) -> Result<Option<TaskPlanSkill>, String> {
    let skill_path = dir.join(skill_id).join("SKILL.md");
    if !skill_path.exists() {
        return Ok(None);
    }
    let builtins = builtin_skills_for_dir(dir)?;
    let content = std::fs::read_to_string(&skill_path).map_err(|err| err.to_string())?;
    let mut skill = parse_skill_markdown(
        skill_id,
        &content,
        Some(skill_path.to_string_lossy().to_string()),
        true,
        builtin_by_id(&builtins, skill_id).is_some(),
        false,
    );
    if let Some(builtin) = builtin_by_id(&builtins, skill_id) {
        let skill_dir = dir.join(skill_id);
        apply_install_integrity(&mut skill, &skill_dir, builtin);
    }
    Ok(Some(skill))
}

fn builtin_by_id<'a>(
    builtins: &'a [BuiltinTaskPlanSkill],
    skill_id: &str,
) -> Option<&'a BuiltinTaskPlanSkill> {
    builtins.iter().find(|skill| skill.id == skill_id)
}

fn apply_install_integrity(
    skill: &mut TaskPlanSkill,
    skill_dir: &Path,
    builtin: &BuiltinTaskPlanSkill,
) {
    if matches!(&builtin.source, InstallSource::Bundled) {
        return;
    }
    if !has_skill_file(&skill_dir.join("upstream")) {
        skill.valid = false;
        skill.error = Some(
            "Missing upstream skill content. Repair install to fetch the real source skill."
                .to_string(),
        );
        skill.roles.clear();
    }
}

fn has_skill_file(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    for entry in entries.flatten() {
        let child = entry.path();
        if child.is_dir() {
            if has_skill_file(&child) {
                return true;
            }
        } else if child
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
        {
            return true;
        }
    }
    false
}

fn parse_skill_markdown(
    fallback_id: &str,
    content: &str,
    path: Option<String>,
    installed: bool,
    builtin: bool,
    installable: bool,
) -> TaskPlanSkill {
    let meta = parse_frontmatter(content);
    let id = meta
        .get("id")
        .cloned()
        .unwrap_or_else(|| fallback_id.to_string());
    let name = meta.get("name").cloned().unwrap_or_else(|| id.clone());
    let description = meta.get("description").cloned().unwrap_or_default();
    let content_bytes = content.as_bytes().len() as u64;
    let content_hash = format!("{:x}", Sha256::digest(content.as_bytes()));
    let (valid, error, roles, workflow_hints) = match parse_manifest(content) {
        Ok(manifest) => {
            let roles = normalize_roles(&manifest.roles);
            if roles.is_empty() {
                (
                    false,
                    Some(
                        "Task plan skill manifest must define at least one valid role".to_string(),
                    ),
                    Vec::new(),
                    None,
                )
            } else {
                (true, None, roles, manifest.workflow_hints)
            }
        }
        Err(err) => (false, Some(err), Vec::new(), None),
    };

    TaskPlanSkill {
        id,
        name,
        description,
        path,
        installed,
        builtin,
        installable,
        valid,
        error,
        content_bytes,
        content_hash,
        workflow_hints,
        roles,
    }
}

fn parse_frontmatter(content: &str) -> HashMap<String, String> {
    let mut meta = HashMap::new();
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return meta;
    }
    for line in lines {
        if line == "---" {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            meta.insert(
                key.trim().to_string(),
                value.trim().trim_matches('"').to_string(),
            );
        }
    }
    meta
}

fn parse_manifest(content: &str) -> Result<SkillManifest, String> {
    if content.trim().is_empty() {
        return Err("Task plan skill file is empty".to_string());
    }
    let start = content
        .find("<!-- jishu-task-plan")
        .ok_or_else(|| "Missing <!-- jishu-task-plan manifest block".to_string())?;
    let body_start = content[start..]
        .find('\n')
        .map(|offset| offset + start + 1)
        .ok_or_else(|| "Task plan manifest block has no JSON body".to_string())?;
    let body_end = content[body_start..]
        .find("-->")
        .map(|offset| offset + body_start)
        .ok_or_else(|| "Task plan manifest block is not closed".to_string())?;
    serde_json::from_str(content[body_start..body_end].trim())
        .map_err(|err| format!("Invalid task plan manifest JSON: {err}"))
}

fn normalize_roles(roles: &[RoleManifest]) -> Vec<TaskPlanRole> {
    let names: HashMap<String, String> = roles
        .iter()
        .map(|role| (role.role_id.clone(), role.role_name.clone()))
        .collect();

    roles
        .iter()
        .filter(|role| !role.role_id.trim().is_empty() && !role.role_name.trim().is_empty())
        .map(|role| {
            let collaborators = role
                .collaborate_with
                .iter()
                .map(|id| names.get(id).cloned().unwrap_or_else(|| id.clone()))
                .collect::<Vec<_>>();
            TaskPlanRole {
                role_id: role.role_id.clone(),
                role_name: role.role_name.clone(),
                responsibilities: normalized_responsibilities(role, &collaborators),
                acceptance: normalized_acceptance(role, &collaborators),
                can_edit_files: role.can_edit_files,
                can_run_commands: role.can_run_commands,
                can_receive_rework: role.can_receive_rework,
            }
        })
        .collect()
}

fn normalized_responsibilities(role: &RoleManifest, collaborators: &[String]) -> Vec<String> {
    let collaborator_text = if collaborators.is_empty() {
        "独立负责本角色产出，并在需要时向 jishu agent 反馈阻塞。".to_string()
    } else {
        format!(
            "需要与 [{}] 互动，接收其产出、反馈问题，并把结论写入任务记录。",
            collaborators.join("、")
        )
    };
    let deliverables = if role.deliverables.is_empty() {
        "产出可被后续角色直接使用的结论、变更或验证记录。".to_string()
    } else {
        format!("交付物：{}。", role.deliverables.join("、"))
    };

    let mut lines = vec![
        format!("角色目标：{}。", trim_period(&role.purpose)),
        format!("协作对象：{}", collaborator_text),
        deliverables,
    ];
    lines.extend(
        role.responsibilities
            .iter()
            .filter(|line| !line.trim().is_empty())
            .map(|line| format!("执行规则：{}", trim_period(line))),
    );
    lines.push("返工规则：当发现问题时，必须标注责任角色、问题原因、建议动作，并交给 jishu agent 生成返工任务。".to_string());
    lines
}

fn normalized_acceptance(role: &RoleManifest, collaborators: &[String]) -> Vec<String> {
    let mut lines = vec![format!(
        "产物验收：{} 的产出能够支撑任务继续推进。",
        role.role_name
    )];
    if !collaborators.is_empty() {
        lines.push(format!(
            "交互验收：已审核或消费 [{}] 的相关产出，并给出明确结论。",
            collaborators.join("、")
        ));
    }
    lines.extend(
        role.acceptance
            .iter()
            .filter(|line| !line.trim().is_empty())
            .map(|line| format!("质量验收：{}", trim_period(line))),
    );
    lines.push("追踪验收：职责、结论、风险和返工对象均可被 jishu agent 解析。".to_string());
    lines
}

fn trim_period(value: &str) -> String {
    value
        .trim()
        .trim_end_matches('。')
        .trim_end_matches('.')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_manifest_normalizes_role_contracts() {
        let skill = parse_skill_markdown(
            "x",
            r#"---
id: x
name: X
description: demo
---
<!-- jishu-task-plan
{"roles":[{"role_id":"developer","role_name":"开发角色","purpose":"实现代码","can_edit_files":true},{"role_id":"auditor","role_name":"审计员","purpose":"审核开发角色的代码质量","collaborate_with":["developer"],"deliverables":["审计报告"],"responsibilities":["标注责任角色"],"acceptance":["无 P0 风险"],"can_run_commands":true}]}
-->
"#,
            None,
            true,
            false,
            false,
        );

        let auditor = skill
            .roles
            .iter()
            .find(|role| role.role_id == "auditor")
            .unwrap();
        assert!(auditor.responsibilities[1].contains("开发角色"));
        assert!(auditor.acceptance[1].contains("开发角色"));
    }

    // ── Pi 扩展部署辅助测试 ──

    fn ext_test_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("jishu-ext-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn settings_extensions(dir: &Path) -> Vec<String> {
        let content = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&content).unwrap();
        v.get("extensions")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|x| x.as_str().unwrap().to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn register_extension_creates_settings_when_absent() {
        let dir = ext_test_dir("absent");
        register_extension_in_settings(&dir, "extensions/request-user-input.ts");
        assert!(settings_extensions(&dir).contains(&"extensions/request-user-input.ts".into()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn register_extension_is_idempotent_and_preserves_other_keys() {
        let dir = ext_test_dir("idempotent");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"defaultModel":"gpt-4o","extensions":["extensions/other.ts"]}"#,
        )
        .unwrap();
        register_extension_in_settings(&dir, "extensions/request-user-input.ts");
        let between = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        register_extension_in_settings(&dir, "extensions/request-user-input.ts");
        let after = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert_eq!(between, after, "二次注册不应改写文件");
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(
            v.get("defaultModel").and_then(|x| x.as_str()),
            Some("gpt-4o")
        );
        let arr = settings_extensions(&dir);
        assert_eq!(arr.len(), 2);
        assert!(arr.contains(&"extensions/other.ts".into()));
        assert!(arr.contains(&"extensions/request-user-input.ts".into()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn register_extension_skips_corrupt_and_non_object_settings() {
        let dir = ext_test_dir("corrupt");
        // JSON 损坏：不动文件
        let corrupt = "not a json";
        std::fs::write(dir.join("settings.json"), corrupt).unwrap();
        register_extension_in_settings(&dir, "extensions/request-user-input.ts");
        assert_eq!(
            std::fs::read_to_string(dir.join("settings.json")).unwrap(),
            corrupt
        );
        // 顶层非 object：不动文件
        let arr_only = r#"["a","b"]"#;
        std::fs::write(dir.join("settings.json"), arr_only).unwrap();
        register_extension_in_settings(&dir, "extensions/request-user-input.ts");
        assert_eq!(
            std::fs::read_to_string(dir.join("settings.json")).unwrap(),
            arr_only
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deploy_extension_file_is_idempotent() {
        let dir = ext_test_dir("deploy");
        deploy_extension_file(&dir, "extensions/x.ts", "hello");
        assert_eq!(
            std::fs::read_to_string(dir.join("extensions/x.ts")).unwrap(),
            "hello"
        );
        // 内容相同再调：内容不变、不报错
        deploy_extension_file(&dir, "extensions/x.ts", "hello");
        assert_eq!(
            std::fs::read_to_string(dir.join("extensions/x.ts")).unwrap(),
            "hello"
        );
        // 内容变化：覆盖
        deploy_extension_file(&dir, "extensions/x.ts", "world");
        assert_eq!(
            std::fs::read_to_string(dir.join("extensions/x.ts")).unwrap(),
            "world"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_both_extensions_deploy_and_register() {
        let dir = ext_test_dir("both");
        ensure_conductor_extension_in(&dir);
        ensure_request_user_input_extension_in(&dir);
        // 两个 .ts 扩展文件已部署
        assert!(dir.join("extensions/jishu-task-conductor.ts").is_file());
        assert!(dir.join("extensions/request-user-input.ts").is_file());
        // conductor skill pack 仍在
        assert!(dir
            .join("skills/jishu-conductor-dev/discuss.SKILL.md")
            .is_file());
        // settings.json 同时含两条扩展
        let arr = settings_extensions(&dir);
        assert!(arr.contains(&"extensions/jishu-task-conductor.ts".into()));
        assert!(arr.contains(&"extensions/request-user-input.ts".into()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
