use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::util::now_ms;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskLaunchInstance {
    pub task_id: String,
    pub project_root: String,
    pub title: String,
    pub skill_id: String,
    pub status: String,
    pub current_phase: String,
    pub requirement_file: Option<String>,
    pub requirement_session_id: Option<String>,
    pub planning_session_id: Option<String>,
    pub graph_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRequirementMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRequirementFinalized {
    pub task_id: String,
    pub title: String,
    pub requirement_dir: String,
    pub requirement_file: String,
    pub planning_instruction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct TaskLaunchIndex {
    #[serde(default)]
    tasks: BTreeMap<String, TaskLaunchInstance>,
}

pub fn list_task_instances(project_root: &str) -> Result<Vec<TaskLaunchInstance>, String> {
    let index = read_index(project_root)?;
    let mut tasks = index.tasks.into_values().collect::<Vec<_>>();
    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(tasks)
}

pub fn mark_task_stage_session(
    project_root: &str,
    task_id: Option<&str>,
    session_id: &str,
    skill_id: &str,
    phase: &str,
    title: Option<&str>,
) -> Result<TaskLaunchInstance, String> {
    if session_id.trim().is_empty() {
        return Err("session_id is required".into());
    }
    let phase = normalize_phase(phase);
    let mut index = read_index(project_root)?;
    let id = task_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("task_{}", uuid::Uuid::new_v4().simple()));
    let now = now_ms();
    let entry = index
        .tasks
        .entry(id.clone())
        .or_insert_with(|| TaskLaunchInstance {
            task_id: id.clone(),
            project_root: project_root.to_string(),
            title: title
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("新任务")
                .to_string(),
            skill_id: skill_id.to_string(),
            status: "requirements_discussing".into(),
            current_phase: phase.clone(),
            requirement_file: None,
            requirement_session_id: None,
            planning_session_id: None,
            graph_id: None,
            created_at: now,
            updated_at: now,
        });
    entry.skill_id = skill_id.to_string();
    entry.current_phase = phase.clone();
    entry.updated_at = now;
    if let Some(title) = title.map(str::trim).filter(|value| !value.is_empty()) {
        entry.title = title.to_string();
    }
    match phase.as_str() {
        "planning" => {
            entry.planning_session_id = Some(session_id.to_string());
            entry.status = "planning_discussing".into();
        }
        _ => {
            entry.requirement_session_id = Some(session_id.to_string());
            entry.status = "requirements_discussing".into();
        }
    }
    let saved = entry.clone();
    write_index(project_root, &index)?;
    Ok(saved)
}

pub fn finalize_requirement(
    project_root: &str,
    task_id: Option<&str>,
    session_id: Option<&str>,
    skill_id: &str,
    title: Option<&str>,
    messages: Vec<TaskRequirementMessage>,
) -> Result<TaskRequirementFinalized, String> {
    let mut index = read_index(project_root)?;
    let id = task_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("task_{}", uuid::Uuid::new_v4().simple()));
    let final_title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| derive_title(&messages))
        .unwrap_or_else(|| "新任务需求".to_string());
    let requirement_dir = task_workspace_root(project_root)
        .join(&id)
        .join("requirements");
    std::fs::create_dir_all(&requirement_dir).map_err(|err| err.to_string())?;
    let requirement_file = requirement_dir.join("requirements.md");
    let content = render_requirement_markdown(&final_title, skill_id, session_id, &messages);
    crate::util::atomic_write(&requirement_file, content.as_bytes())
        .map_err(|err| err.to_string())?;

    let now = now_ms();
    let entry = index
        .tasks
        .entry(id.clone())
        .or_insert_with(|| TaskLaunchInstance {
            task_id: id.clone(),
            project_root: project_root.to_string(),
            title: final_title.clone(),
            skill_id: skill_id.to_string(),
            status: "requirements_finalized".into(),
            current_phase: "requirements".into(),
            requirement_file: None,
            requirement_session_id: None,
            planning_session_id: None,
            graph_id: None,
            created_at: now,
            updated_at: now,
        });
    entry.title = final_title.clone();
    entry.skill_id = skill_id.to_string();
    entry.status = "requirements_finalized".into();
    entry.current_phase = "requirements".into();
    entry.requirement_file = Some(requirement_file.to_string_lossy().to_string());
    if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
        entry.requirement_session_id = Some(session_id.to_string());
    }
    entry.updated_at = now;
    write_index(project_root, &index)?;

    let planning_instruction = build_planning_instruction_from_requirement(&requirement_file)?;
    Ok(TaskRequirementFinalized {
        task_id: id,
        title: final_title,
        requirement_dir: requirement_dir.to_string_lossy().to_string(),
        requirement_file: requirement_file.to_string_lossy().to_string(),
        planning_instruction,
    })
}

pub fn attach_graph(
    project_root: &str,
    task_id: &str,
    graph_id: &str,
) -> Result<TaskLaunchInstance, String> {
    let mut index = read_index(project_root)?;
    let entry = index
        .tasks
        .get_mut(task_id)
        .ok_or_else(|| format!("task instance not found: {task_id}"))?;
    entry.graph_id = Some(graph_id.to_string());
    entry.status = "graph_created".into();
    entry.current_phase = "graph".into();
    entry.updated_at = now_ms();
    let saved = entry.clone();
    write_index(project_root, &index)?;
    Ok(saved)
}

pub fn rename_task(
    project_root: &str,
    task_id: &str,
    title: &str,
) -> Result<TaskLaunchInstance, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("title is required".into());
    }
    let mut index = read_index(project_root)?;
    let entry = index
        .tasks
        .get_mut(task_id)
        .ok_or_else(|| format!("task instance not found: {task_id}"))?;
    entry.title = title.to_string();
    entry.updated_at = now_ms();
    let saved = entry.clone();
    write_index(project_root, &index)?;
    Ok(saved)
}

pub fn delete_task(project_root: &str, task_id: &str) -> Result<(), String> {
    let mut index = read_index(project_root)?;
    index.tasks.remove(task_id);
    write_index(project_root, &index)?;
    let dir = task_workspace_root(project_root).join(task_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn normalize_phase(phase: &str) -> String {
    match phase {
        "planning" => "planning".into(),
        _ => "requirements".into(),
    }
}

fn build_planning_instruction_from_requirement(requirement_file: &Path) -> Result<String, String> {
    let content = std::fs::read_to_string(requirement_file).map_err(|err| err.to_string())?;
    Ok(format!(
        "请读取以下需求终稿，并基于该需求与用户进行任务流程规划讨论。当前阶段不要直接执行任务，也不要要求用户去画布点击智能规划；请在会话中持续澄清流程节点、职责、依赖、验收与风险。当流程方案明确后，请发起交互式确认，询问用户是否生成任务流程图。\n\n需求终稿文件：{}\n\n--- 需求终稿开始 ---\n{}\n--- 需求终稿结束 ---",
        requirement_file.display(),
        content.trim(),
    ))
}

fn render_requirement_markdown(
    title: &str,
    skill_id: &str,
    session_id: Option<&str>,
    messages: &[TaskRequirementMessage],
) -> String {
    let mut output = String::new();
    output.push_str("# ");
    output.push_str(title.trim());
    output.push_str("\n\n");
    output.push_str("- 需求稿类型：任务流程生成终稿\n");
    output.push_str("- 驱动技能：");
    output.push_str(skill_id);
    output.push('\n');
    if let Some(session_id) = session_id {
        output.push_str("- 来源阶段会话：");
        output.push_str(session_id);
        output.push('\n');
    }
    output.push_str("\n## 定稿内容\n\n");
    for message in messages {
        let content = message.content.trim();
        if content.is_empty() {
            continue;
        }
        let speaker = if message.role == "assistant" {
            "Jishu Agent"
        } else {
            "用户"
        };
        output.push_str("### ");
        output.push_str(speaker);
        output.push_str("\n\n");
        output.push_str(content);
        output.push_str("\n\n");
    }
    output
}

fn derive_title(messages: &[TaskRequirementMessage]) -> Option<String> {
    messages
        .iter()
        .find(|message| message.role == "user" && !message.content.trim().is_empty())
        .map(|message| {
            let mut title = message.content.trim().replace(['\r', '\n', '\t'], " ");
            title.truncate(40);
            title
        })
}

fn task_workspace_root(project_root: &str) -> PathBuf {
    PathBuf::from(project_root).join(".jishu-hub").join("tasks")
}

fn index_path(project_root: &str) -> PathBuf {
    task_workspace_root(project_root).join("task-instances.json")
}

fn read_index(project_root: &str) -> Result<TaskLaunchIndex, String> {
    let path = index_path(project_root);
    if !path.exists() {
        return Ok(TaskLaunchIndex::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|err| err.to_string())?;
    serde_json::from_str(&content).map_err(|err| err.to_string())
}

fn write_index(project_root: &str, index: &TaskLaunchIndex) -> Result<(), String> {
    let path = index_path(project_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let content = serde_json::to_vec_pretty(index).map_err(|err| err.to_string())?;
    crate::util::atomic_write(&path, &content).map_err(|err| err.to_string())
}
