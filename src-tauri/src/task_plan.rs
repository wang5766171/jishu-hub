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
    let home = dirs::home_dir().ok_or_else(|| "Cannot find home directory".to_string())?;
    Ok(home.join(".jishu-agent"))
}

pub fn task_plan_dir() -> Result<PathBuf, String> {
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
    // Copy extra bundled files (scripts/, references/) so the installed skill
    // is a faithful copy of the bundled resource directory, not just SKILL.md.
    copy_bundled_extra_files(skill_id, &skill_dir)?;
    write_install_metadata(builtin, &skill_dir)?;
    // Also link the skill into Pi's native skill discovery path
    // (<agentDir>/skills/<skill_id>) so Pi loads it as a real skill and
    // the agent recognizes it in its skill list. Without this, Pi only
    // scans <agentDir>/skills/ and never sees <agentDir>/task-plan/.
    let _ = link_to_pi_skills_dir(skill_id, &skill_dir);
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

/// Copy extra bundled files (scripts/, references/, etc.) from the bundled
/// resource directory to the installed skill directory. The bundled directory
/// is `src-tauri/resources/task-plan/<skill_id>/` (embedded at compile time).
///
/// Only copies directories that exist in the bundled resources — missing dirs
/// are silently skipped (backward compatible with skills that only have SKILL.md).
fn copy_bundled_extra_files(skill_id: &str, dest_dir: &Path) -> Result<(), String> {
    let extra_dirs = ["scripts", "references", "assets"];
    for sub in &extra_dirs {
        let bundled_key = format!("{skill_id}/{sub}");
        let entries = match bundled_dir_entries(&bundled_key) {
            Some(e) => e,
            None => continue,
        };
        let dest_sub = dest_dir.join(sub);
        std::fs::create_dir_all(&dest_sub).map_err(|err| err.to_string())?;
        for (filename, content) in entries {
            let dest_file = dest_sub.join(&filename);
            crate::util::atomic_write(&dest_file, &content).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

/// Create a symlink (or copy on Windows) from `<agentDir>/skills/<skill_id>`
/// to the task-plan skill directory, so Pi's native skill loader discovers it.
/// Pi scans `<agentDir>/skills/` for SKILL.md files — without this link,
/// task-plan skills in `<agentDir>/task-plan/` are invisible to the agent.
fn link_to_pi_skills_dir(skill_id: &str, skill_dir: &Path) -> Result<(), String> {
    let agent_dir = jishu_agent_dir()?;
    let skills_dir = agent_dir.join("skills");
    std::fs::create_dir_all(&skills_dir).map_err(|err| err.to_string())?;
    let link_path = skills_dir.join(skill_id);

    // Remove existing link/dir if present (re-install case).
    if link_path.exists() || link_path.is_symlink() {
        if link_path.is_dir() && !link_path.is_symlink() {
            std::fs::remove_dir_all(&link_path).map_err(|err| err.to_string())?;
        } else {
            std::fs::remove_file(&link_path).map_err(|err| err.to_string())?;
        }
    }

    // Try symlink first (works on Unix and Windows with developer mode).
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(skill_dir, &link_path).map_err(|err| err.to_string())?;
        return Ok(());
    }

    // Windows: try symlink, fall back to directory copy.
    #[cfg(windows)]
    {
        // std::os::windows::fs::symlink_dir requires developer mode or admin.
        if std::os::windows::fs::symlink_dir(skill_dir, &link_path).is_ok() {
            return Ok(());
        }
        // Fallback: copy the skill directory contents.
        copy_skill_dir(skill_dir, &link_path)?;
        return Ok(());
    }

    #[cfg(not(any(unix, windows)))]
    {
        copy_skill_dir(skill_dir, &link_path)?;
        Ok(())
    }
}

/// Recursively copy a skill directory (for Windows symlink fallback).
fn copy_skill_dir(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_skill_dir(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Retrieve the list of (filename, content) pairs embedded in a bundled
/// resource subdirectory. Returns None if the directory has no extra files.
fn bundled_dir_entries(key: &str) -> Option<Vec<(String, Vec<u8>)>> {
    // Bundled extra files are embedded via include_dir or similar. For now,
    // we use compile-time include_bytes! for each known skill's extra files.
    // This is intentionally extensible — add new entries as skills grow.
    match key {
        "jishu-task-planner/scripts" => Some(vec![
            (
                "format_requirement.mjs".to_string(),
                include_bytes!(
                    "../resources/task-plan/jishu-task-planner/scripts/format_requirement.mjs"
                )
                .to_vec(),
            ),
            (
                "format_flow_plan.mjs".to_string(),
                include_bytes!(
                    "../resources/task-plan/jishu-task-planner/scripts/format_flow_plan.mjs"
                )
                .to_vec(),
            ),
            (
                "advance_phase.mjs".to_string(),
                include_bytes!(
                    "../resources/task-plan/jishu-task-planner/scripts/advance_phase.mjs"
                )
                .to_vec(),
            ),
        ]),
        "jishu-task-planner/references" => Some(vec![
            (
                "requirements-phase.md".to_string(),
                include_bytes!(
                    "../resources/task-plan/jishu-task-planner/references/requirements-phase.md"
                )
                .to_vec(),
            ),
            (
                "planning-phase.md".to_string(),
                include_bytes!(
                    "../resources/task-plan/jishu-task-planner/references/planning-phase.md"
                )
                .to_vec(),
            ),
        ]),
        _ => None,
    }
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
    fn bundled_task_planner_scripts_include_phase_advancer() {
        let entries = bundled_dir_entries("jishu-task-planner/scripts").unwrap();
        assert!(entries
            .iter()
            .any(|(filename, content)| filename == "advance_phase.mjs"
                && String::from_utf8_lossy(content).contains("advance_phase.mjs")));
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
