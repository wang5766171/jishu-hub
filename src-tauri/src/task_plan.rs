use serde::{Deserialize, Serialize};
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
    #[serde(default)]
    adapter_key: Option<String>,
    #[serde(default)]
    adapter_markdown: Option<String>,
    #[serde(default)]
    adapter_path: Option<String>,
    source: InstallSource,
}

#[derive(Debug, Clone)]
struct BuiltinTaskPlanSkill {
    id: String,
    adapter: String,
    source: InstallSource,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum InstallSource {
    Bundled,
    GitSparse { repo: String, path: String },
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
    let home = dirs::home_dir().ok_or_else(|| "Cannot find home directory".to_string())?;
    Ok(home.join(".jishu-agent"))
}

fn task_plan_dir() -> Result<PathBuf, String> {
    Ok(jishu_agent_dir()?.join("task-plan"))
}

fn builtin_skills_for_dir(dir: &Path) -> Result<Vec<BuiltinTaskPlanSkill>, String> {
    let user_registry = dir.join("registry.json");
    let (content, registry_dir) = if user_registry.exists() {
        (
            std::fs::read_to_string(&user_registry).map_err(|err| err.to_string())?,
            user_registry.parent().map(Path::to_path_buf),
        )
    } else {
        (BUNDLED_TASK_PLAN_REGISTRY.to_string(), None)
    };
    let manifest: TaskPlanRegistryManifest = serde_json::from_str(&content)
        .map_err(|err| format!("Invalid task-plan registry: {err}"))?;
    manifest
        .skills
        .into_iter()
        .map(|entry| registry_entry_to_builtin(entry, registry_dir.as_deref()))
        .collect()
}

fn registry_entry_to_builtin(
    entry: TaskPlanRegistryEntry,
    registry_dir: Option<&Path>,
) -> Result<BuiltinTaskPlanSkill, String> {
    let adapter = load_registry_adapter(&entry, registry_dir)?;
    Ok(BuiltinTaskPlanSkill {
        id: entry.id,
        adapter,
        source: entry.source,
    })
}

fn load_registry_adapter(
    entry: &TaskPlanRegistryEntry,
    registry_dir: Option<&Path>,
) -> Result<String, String> {
    if let Some(markdown) = &entry.adapter_markdown {
        return Ok(markdown.clone());
    }
    if let Some(path) = &entry.adapter_path {
        let adapter_path = registry_dir
            .map(|dir| dir.join(path))
            .unwrap_or_else(|| PathBuf::from(path));
        return std::fs::read_to_string(&adapter_path).map_err(|err| {
            format!(
                "Cannot read task-plan adapter {}: {err}",
                adapter_path.display()
            )
        });
    }
    if let Some(key) = &entry.adapter_key {
        return bundled_adapter(key)
            .map(str::to_string)
            .ok_or_else(|| format!("Unknown bundled task-plan adapter: {key}"));
    }
    Err(format!(
        "Task-plan registry entry '{}' must define adapter_key, adapter_path or adapter_markdown",
        entry.id
    ))
}

fn bundled_adapter(key: &str) -> Option<&'static str> {
    match key {
        "jishu-task-planner" => Some(include_str!(
            "../resources/task-plan/jishu-task-planner/SKILL.md"
        )),
        "gstack" => Some(include_str!("../resources/task-plan/gstack/SKILL.md")),
        "superpowers" => Some(include_str!("../resources/task-plan/superpowers/SKILL.md")),
        "openspec" => Some(include_str!("../resources/task-plan/openspec/SKILL.md")),
        "compound-engineering" => Some(include_str!(
            "../resources/task-plan/compound-engineering/SKILL.md"
        )),
        _ => None,
    }
}

pub fn list_task_plan_skills() -> Result<Vec<TaskPlanSkill>, String> {
    list_task_plan_skills_in_dir(&task_plan_dir()?)
}

pub fn install_builtin_skill(skill_id: &str) -> Result<TaskPlanSkill, String> {
    install_builtin_skill_in_dir(skill_id, &task_plan_dir()?)
}

pub fn generate_roles(skill_id: &str, message: &str) -> Result<Vec<TaskPlanRole>, String> {
    let dir = task_plan_dir()?;
    let skill = read_installed_skill(&dir, skill_id)?
        .ok_or_else(|| format!("Task plan skill '{skill_id}' is not installed"))?;
    if !skill.valid {
        return Err(skill
            .error
            .unwrap_or_else(|| format!("Task plan skill '{skill_id}' is invalid")));
    }

    // Try LLM-powered role generation first; fall back to template roles
    match generate_roles_with_llm(message, &skill.roles) {
        Ok(roles) if !roles.is_empty() => Ok(roles),
        _ => Ok(skill.roles),
    }
}

/// Use the configured LLM to dynamically generate roles based on the task message
/// and the skill template's role patterns.
fn generate_roles_with_llm(
    message: &str,
    template_roles: &[TaskPlanRole],
) -> Result<Vec<TaskPlanRole>, String> {
    let store = crate::llm::config::ModelStore::load()?;
    let preset = store
        .get_active()
        .ok_or_else(|| "No active model configured".to_string())?
        .clone();
    let provider = crate::llm::create_provider(&preset)?;

    let template_desc = template_roles
        .iter()
        .map(|r| {
            format!(
                "- {} ({}): {}",
                r.role_name,
                r.role_id,
                r.responsibilities.first().map(|s| s.as_str()).unwrap_or("N/A")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let system_prompt = r#"You are a task planning assistant. Given a task description and a set of available role patterns, generate the specific roles needed for this task.

Return ONLY a JSON array of role objects. Each object must have:
- role_id: snake_case identifier (use one of the available patterns or derive from it)
- role_name: display name in Chinese
- responsibilities: array of 2-4 specific responsibility strings in Chinese
- acceptance: array of 1-3 acceptance criteria strings in Chinese
- can_edit_files: boolean
- can_run_commands: boolean
- can_receive_rework: boolean

Rules:
- Select only the roles actually needed for this task (2-5 roles typically)
- Adapt responsibilities and acceptance criteria to the specific task
- The last role should be an auditor/reviewer that checks quality
- can_receive_rework should be true for roles that can receive feedback (developers, designers)
- can_receive_rework should be false for auditor roles
- Return ONLY the JSON array, no markdown fences, no explanation"#;

    let user_prompt = format!(
        "Task: {}\n\nAvailable role patterns:\n{}",
        message, template_desc
    );

    let req = crate::llm::message::LlmRequest {
        model: preset.model.clone(),
        messages: vec![
            crate::llm::message::LlmMessage {
                role: crate::llm::message::LlmRole::System,
                content: Some(system_prompt.to_string()),
                tool_calls: None,
                tool_call_id: None,
            },
            crate::llm::message::LlmMessage {
                role: crate::llm::message::LlmRole::User,
                content: Some(user_prompt),
                tool_calls: None,
                tool_call_id: None,
            },
        ],
        tools: vec![],
        stream: false,
        max_tokens: Some(4096),
        temperature: Some(0.3),
    };

    let cancel = crate::llm::CancelToken::new();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("Runtime: {e}"))?;

    let text = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let text_clone = text.clone();
    let cancel_for_async = cancel.clone();
    let result = rt.block_on(async {
        use tokio::time::{timeout, Duration};
        let inner = provider.stream_chat(
            req,
            Box::new(move |event| {
                if let crate::agent::NormalizedEvent::TextDelta { delta } = event {
                    if let Ok(mut t) = text_clone.lock() {
                        t.push_str(&delta);
                    }
                }
            }),
            &cancel_for_async,
        );
        // 5s timeout — fall back to template
        match timeout(Duration::from_secs(5), inner).await {
            Ok(r) => r,
            Err(_) => {
                cancel.cancel();
                Err(crate::llm::LlmError::Request("LLM timed out (15s)".into()))
            }
        }
    });

    if let Err(e) = result {
        // LLM failed — return empty to fall back to template
        eprintln!("[task-plan] LLM role generation failed: {e}");
        return Ok(Vec::new());
    }
    let response_text = text.lock().map_err(|e| e.to_string())?.clone();

    // Parse the JSON response — handle possible markdown fences
    let json_str = response_text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let raw_roles: Vec<RawLlmRole> = serde_json::from_str(json_str)
        .map_err(|e| format!("Failed to parse LLM role response: {e}"))?;

    Ok(raw_roles
        .into_iter()
        .filter(|r| !r.role_id.is_empty() && !r.role_name.is_empty())
        .map(|r| TaskPlanRole {
            role_id: r.role_id,
            role_name: r.role_name,
            responsibilities: r.responsibilities,
            acceptance: r.acceptance,
            can_edit_files: r.can_edit_files,
            can_run_commands: r.can_run_commands,
            can_receive_rework: r.can_receive_rework,
        })
        .collect())
}

#[derive(Deserialize)]
struct RawLlmRole {
    role_id: String,
    role_name: String,
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

fn list_task_plan_skills_in_dir(dir: &Path) -> Result<Vec<TaskPlanSkill>, String> {
    let mut skills = Vec::new();
    let mut installed_ids = HashSet::new();
    let builtins = builtin_skills_for_dir(dir)?;

    if dir.exists() {
        for entry in std::fs::read_dir(dir).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_path = path.join("SKILL.md");
            if !skill_path.exists() {
                continue;
            }
            let fallback_id = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("task-plan-skill");
            let content = std::fs::read_to_string(&skill_path).map_err(|err| err.to_string())?;
            let mut skill = parse_skill_markdown(
                fallback_id,
                &content,
                Some(skill_path.to_string_lossy().to_string()),
                true,
                builtin_by_id(&builtins, fallback_id).is_some(),
                false,
            );
            if let Some(builtin) = builtin_by_id(&builtins, fallback_id) {
                apply_install_integrity(&mut skill, &path, builtin);
            }
            if skill.builtin && !skill.valid {
                skill.installable = true;
            }
            installed_ids.insert(skill.id.clone());
            skills.push(skill);
        }
    }

    for builtin in &builtins {
        if installed_ids.contains(&builtin.id) {
            continue;
        }
        skills.push(parse_skill_markdown(
            &builtin.id,
            &builtin.adapter,
            None,
            false,
            true,
            true,
        ));
    }

    skills.sort_by(|a, b| {
        b.installed
            .cmp(&a.installed)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(skills)
}

fn install_builtin_skill_in_dir(skill_id: &str, dir: &Path) -> Result<TaskPlanSkill, String> {
    let builtins = builtin_skills_for_dir(dir)?;
    let builtin = builtin_by_id(&builtins, skill_id)
        .ok_or_else(|| format!("No built-in task plan skill named '{skill_id}'"))?;
    let skill_dir = dir.join(skill_id);
    std::fs::create_dir_all(&skill_dir).map_err(|err| err.to_string())?;
    install_source(builtin, &skill_dir)?;
    let skill_path = skill_dir.join("SKILL.md");
    crate::util::atomic_write(&skill_path, builtin.adapter.as_bytes())
        .map_err(|err| err.to_string())?;
    write_install_metadata(builtin, &skill_dir)?;
    let written = std::fs::read_to_string(&skill_path).map_err(|err| err.to_string())?;
    let mut skill = parse_skill_markdown(
        skill_id,
        &written,
        Some(skill_path.to_string_lossy().to_string()),
        true,
        true,
        false,
    );
    apply_install_integrity(&mut skill, &skill_dir, builtin);
    if !skill.valid {
        return Err(skill
            .error
            .unwrap_or_else(|| format!("Installed task plan skill '{skill_id}' is invalid")));
    }
    Ok(skill)
}

fn read_installed_skill(dir: &Path, skill_id: &str) -> Result<Option<TaskPlanSkill>, String> {
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

#[derive(Debug, Serialize)]
struct InstallMetadata<'a> {
    id: &'a str,
    installer: &'a str,
    repo: Option<&'a str>,
    path: Option<&'a str>,
}

fn install_source(builtin: &BuiltinTaskPlanSkill, skill_dir: &Path) -> Result<(), String> {
    match &builtin.source {
        InstallSource::Bundled => Ok(()),
        InstallSource::GitSparse { repo, path } => install_git_sparse(repo, path, skill_dir),
    }
}

fn install_git_sparse(repo: &str, path: &str, skill_dir: &Path) -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join(format!("jishu-task-plan-{}", uuid::Uuid::new_v4()));
    let upstream_dir = skill_dir.join("upstream");
    let clone_result = (|| {
        let temp = temp_dir
            .to_str()
            .ok_or_else(|| "Temporary path is not valid UTF-8".to_string())?;
        if path == "." {
            run_git(&["clone", "--depth", "1", "--filter=blob:none", repo, temp])?;
        } else {
            run_git(&[
                "clone",
                "--depth",
                "1",
                "--filter=blob:none",
                "--sparse",
                repo,
                temp,
            ])?;
            run_git_in(&temp_dir, &["sparse-checkout", "set", path])?;
        }

        let source_dir = if path == "." {
            temp_dir.clone()
        } else {
            temp_dir.join(path)
        };
        if !source_dir.exists() {
            return Err(format!("Upstream skill path not found after clone: {path}"));
        }
        if upstream_dir.exists() {
            std::fs::remove_dir_all(&upstream_dir).map_err(|err| err.to_string())?;
        }
        copy_dir_all(&source_dir, &upstream_dir)
    })();
    let _ = std::fs::remove_dir_all(&temp_dir);
    clone_result
}

fn run_git(args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .args(args)
        .output()
        .map_err(|err| format!("Failed to run git: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "git {} failed: {}{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

fn run_git_in(cwd: &Path, args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|err| format!("Failed to run git: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "git {} failed in {}: {}{}",
            args.join(" "),
            cwd.display(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

fn copy_dir_all(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|err| err.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        if entry.file_name().to_string_lossy() == ".git" {
            continue;
        }
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_dir_all(&source, &target)?;
        } else {
            std::fs::copy(&source, &target).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn write_install_metadata(builtin: &BuiltinTaskPlanSkill, skill_dir: &Path) -> Result<(), String> {
    let (repo, path) = match &builtin.source {
        InstallSource::Bundled => (None, None),
        InstallSource::GitSparse { repo, path } => (Some(repo.as_str()), Some(path.as_str())),
    };
    let metadata = InstallMetadata {
        id: &builtin.id,
        installer: "jishu-task-plan",
        repo,
        path,
    };
    let json = serde_json::to_string_pretty(&metadata).map_err(|err| err.to_string())?;
    crate::util::atomic_write(&skill_dir.join("install.json"), json.as_bytes())
        .map_err(|err| err.to_string())
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
    let (valid, error, roles) = match parse_manifest(content) {
        Ok(manifest) => {
            let roles = normalize_roles(&manifest.roles);
            if roles.is_empty() {
                (
                    false,
                    Some(
                        "Task plan skill manifest must define at least one valid role".to_string(),
                    ),
                    Vec::new(),
                )
            } else {
                (true, None, roles)
            }
        }
        Err(err) => (false, Some(err), Vec::new()),
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

    #[test]
    fn missing_builtin_is_installable_then_installed() {
        let dir = std::env::temp_dir().join(format!("jishu-task-plan-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let before = list_task_plan_skills_in_dir(&dir).unwrap();
        assert!(before
            .iter()
            .any(|skill| skill.id == "jishu-task-planner" && !skill.installed));

        let installed = install_builtin_skill_in_dir("jishu-task-planner", &dir).unwrap();
        assert!(installed.installed);
        assert!(dir.join("jishu-task-planner").join("SKILL.md").exists());

        let after = list_task_plan_skills_in_dir(&dir).unwrap();
        assert!(after
            .iter()
            .any(|skill| skill.id == "jishu-task-planner" && skill.installed));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_builtin_skill_is_invalid_and_marked_repairable() {
        let dir =
            std::env::temp_dir().join(format!("jishu-task-plan-empty-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let skill_dir = dir.join("superpowers");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "").unwrap();

        let before = list_task_plan_skills_in_dir(&dir).unwrap();
        let broken = before
            .iter()
            .find(|skill| skill.id == "superpowers")
            .unwrap();
        assert!(!broken.valid);
        assert!(broken.installable);
        assert_eq!(broken.content_bytes, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_sparse_builtin_without_upstream_is_invalid() {
        let dir = std::env::temp_dir().join(format!(
            "jishu-task-plan-no-upstream-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let skill_dir = dir.join("superpowers");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            builtin_by_id(&builtin_skills_for_dir(&dir).unwrap(), "superpowers")
                .unwrap()
                .adapter
                .as_bytes(),
        )
        .unwrap();

        let skills = list_task_plan_skills_in_dir(&dir).unwrap();
        let broken = skills
            .iter()
            .find(|skill| skill.id == "superpowers")
            .unwrap();
        assert!(!broken.valid);
        assert!(broken.installable);
        assert!(broken
            .error
            .as_deref()
            .unwrap()
            .contains("Missing upstream"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_registry_can_add_installable_skill_without_code_change() {
        let dir = std::env::temp_dir().join(format!(
            "jishu-task-plan-registry-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("registry.json"),
            r#"{
              "skills": [{
                "id": "custom-flow",
                "adapter_markdown": "---\nid: custom-flow\nname: Custom Flow\ndescription: User-defined flow\n---\n<!-- jishu-task-plan\n{\"roles\":[{\"role_id\":\"owner\",\"role_name\":\"Owner\",\"purpose\":\"Own the work\"}]}\n-->\n",
                "source": { "type": "bundled" }
              }]
            }"#,
        )
        .unwrap();

        let skills = list_task_plan_skills_in_dir(&dir).unwrap();
        let custom = skills
            .iter()
            .find(|skill| skill.id == "custom-flow")
            .unwrap();
        assert!(custom.installable);
        assert!(!custom.installed);
        assert_eq!(custom.roles.len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
