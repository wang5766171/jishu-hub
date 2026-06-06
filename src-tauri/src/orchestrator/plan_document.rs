use crate::orchestrator::spec::{Step, StepKind, TaskSpec};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;

pub fn normalize_finish_plan(
    finish_plan_args: Value,
    spec: &TaskSpec,
    fallback_project: &str,
) -> Result<Vec<Step>, PlanNormalizeError> {
    let raw_steps = extract_raw_steps(finish_plan_args)?;
    if raw_steps.is_empty() {
        return Err(PlanNormalizeError::new(
            "finish_plan plan must contain at least one step",
        ));
    }

    let role_ids = spec
        .roles
        .iter()
        .map(|role| role.role_id.as_str())
        .collect::<HashSet<_>>();
    let mut steps = Vec::with_capacity(raw_steps.len());

    for raw in raw_steps {
        let step_id = raw.step_id.trim().to_string();
        let prompt = raw.prompt.trim().to_string();
        let step_type = raw.r#type.trim().to_ascii_lowercase();
        let depends_on = raw
            .depends_on
            .into_iter()
            .map(|dep| dep.trim().to_string())
            .collect::<Vec<_>>();

        let kind = match step_type.as_str() {
            "dispatch" => {
                let role_id = resolve_role_id(raw.role_id.as_deref(), spec, &role_ids)?;
                let project = resolve_project(raw.project.as_deref(), spec, fallback_project);
                StepKind::Dispatch {
                    role_id,
                    prompt,
                    project,
                    session: None,
                }
            }
            "reflect" => StepKind::Reflect { question: prompt },
            "" => {
                return Err(PlanNormalizeError::new(format!(
                    "step '{step_id}' is missing type"
                )))
            }
            other => {
                return Err(PlanNormalizeError::new(format!(
                    "step '{step_id}' has unsupported type '{other}'"
                )))
            }
        };

        steps.push(Step {
            step_id,
            kind,
            depends_on,
            timeout_ms: spec.deadline_ms,
        });
    }

    let validation = validate_plan_steps(&steps, spec, fallback_project);
    if validation.valid {
        Ok(steps)
    } else {
        Err(PlanNormalizeError::new(validation.summary()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanDocument {
    pub schema_version: u32,
    pub run_id: String,
    pub skill_id: Option<String>,
    pub revision: u64,
    pub status: PlanDocumentStatus,
    pub steps: Vec<Step>,
    pub draft: Option<PlanDraft>,
    pub validation: PlanValidation,
    pub updated_at: i64,
}

impl PlanDocument {
    pub fn ready_from_finish_plan(
        run_id: String,
        skill_id: Option<String>,
        revision: u64,
        raw_finish_plan_args: Value,
        spec: &TaskSpec,
        fallback_project: &str,
        updated_at: i64,
    ) -> Result<Self, PlanNormalizeError> {
        let steps = normalize_finish_plan(raw_finish_plan_args.clone(), spec, fallback_project)?;
        let validation = validate_plan_steps(&steps, spec, fallback_project);
        Ok(Self {
            schema_version: 1,
            run_id,
            skill_id,
            revision,
            status: PlanDocumentStatus::Ready,
            steps,
            draft: Some(PlanDraft {
                raw_finish_plan_args,
                visible_text: String::new(),
                source: PlanDraftSource::PlanAgent,
            }),
            validation,
            updated_at,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanDocumentStatus {
    Draft,
    Ready,
    Editing,
    Updating,
    Executing,
    Complete,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanDraft {
    pub raw_finish_plan_args: Value,
    pub visible_text: String,
    pub source: PlanDraftSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanDraftSource {
    PlanAgent,
    UserPatch,
    Regenerate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanValidation {
    pub valid: bool,
    pub errors: Vec<PlanValidationIssue>,
    pub warnings: Vec<PlanValidationIssue>,
}

impl PlanValidation {
    pub fn valid() -> Self {
        Self {
            valid: true,
            errors: Vec::new(),
            warnings: Vec::new(),
        }
    }

    pub fn from_errors(errors: Vec<PlanValidationIssue>) -> Self {
        Self {
            valid: errors.is_empty(),
            errors,
            warnings: Vec::new(),
        }
    }

    pub fn summary(&self) -> String {
        if self.errors.is_empty() {
            return "plan validation failed".to_string();
        }
        self.errors
            .iter()
            .map(|issue| match &issue.step_id {
                Some(step_id) => format!("{step_id}: {}", issue.message),
                None => issue.message.clone(),
            })
            .collect::<Vec<_>>()
            .join("; ")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanValidationIssue {
    pub code: String,
    pub message: String,
    pub step_id: Option<String>,
}

impl PlanValidationIssue {
    fn new(code: impl Into<String>, message: impl Into<String>, step_id: Option<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            step_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanNormalizeError {
    message: String,
}

impl PlanNormalizeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for PlanNormalizeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PlanNormalizeError {}

pub fn validate_plan_steps(
    steps: &[Step],
    spec: &TaskSpec,
    fallback_project: &str,
) -> PlanValidation {
    let mut errors = Vec::new();
    let mut ids = HashSet::new();
    let role_ids = spec
        .roles
        .iter()
        .map(|role| role.role_id.as_str())
        .collect::<HashSet<_>>();

    for step in steps {
        let step_id = step.step_id.trim();
        if step_id.is_empty() {
            errors.push(PlanValidationIssue::new(
                "empty_step_id",
                "step_id must not be empty",
                None,
            ));
        } else if !ids.insert(step_id.to_string()) {
            errors.push(PlanValidationIssue::new(
                "duplicate_step_id",
                format!("duplicate step_id '{step_id}'"),
                Some(step_id.to_string()),
            ));
        }

        let mut dep_ids = HashSet::new();
        for dep in &step.depends_on {
            let dep_id = dep.trim();
            if dep_id.is_empty() {
                errors.push(PlanValidationIssue::new(
                    "empty_dependency",
                    "depends_on entries must not be empty",
                    Some(step.step_id.clone()),
                ));
            } else if !dep_ids.insert(dep_id.to_string()) {
                errors.push(PlanValidationIssue::new(
                    "duplicate_dependency",
                    format!("duplicate dependency '{dep_id}'"),
                    Some(step.step_id.clone()),
                ));
            }
        }

        match &step.kind {
            StepKind::Dispatch {
                role_id,
                prompt,
                project,
                ..
            } => {
                if role_id.trim().is_empty() {
                    errors.push(PlanValidationIssue::new(
                        "empty_role_id",
                        "dispatch role_id must not be empty",
                        Some(step.step_id.clone()),
                    ));
                } else if !spec.roles.is_empty() && !role_ids.contains(role_id.as_str()) {
                    errors.push(PlanValidationIssue::new(
                        "unknown_role_id",
                        format!("unknown role_id '{role_id}'"),
                        Some(step.step_id.clone()),
                    ));
                }
                if prompt.trim().is_empty() {
                    errors.push(PlanValidationIssue::new(
                        "empty_prompt",
                        "dispatch prompt must not be empty",
                        Some(step.step_id.clone()),
                    ));
                }
                if !project_allowed(project, spec, fallback_project) {
                    errors.push(PlanValidationIssue::new(
                        "project_outside_task",
                        format!("project '{project}' is outside task project"),
                        Some(step.step_id.clone()),
                    ));
                }
            }
            StepKind::Reflect { question } => {
                if question.trim().is_empty() {
                    errors.push(PlanValidationIssue::new(
                        "empty_question",
                        "reflect question must not be empty",
                        Some(step.step_id.clone()),
                    ));
                }
            }
            _ => {}
        }
    }

    let all_ids = steps
        .iter()
        .map(|step| step.step_id.as_str())
        .collect::<HashSet<_>>();
    for step in steps {
        for dep in &step.depends_on {
            let dep_id = dep.trim();
            if !dep_id.is_empty() && !all_ids.contains(dep_id) {
                errors.push(PlanValidationIssue::new(
                    "unknown_dependency",
                    format!("depends_on references unknown step_id '{dep_id}'"),
                    Some(step.step_id.clone()),
                ));
            }
        }
    }

    if dependency_graph_has_cycle(steps) {
        errors.push(PlanValidationIssue::new(
            "dependency_cycle",
            "depends_on graph contains a cycle",
            None,
        ));
    }

    PlanValidation::from_errors(errors)
}

#[derive(Debug, Deserialize)]
struct RawPlanStep {
    #[serde(default)]
    step_id: String,
    #[serde(rename = "type", default)]
    r#type: String,
    #[serde(default)]
    role_id: Option<String>,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    depends_on: Vec<String>,
    #[serde(default)]
    project: Option<String>,
}

fn extract_raw_steps(args: Value) -> Result<Vec<RawPlanStep>, PlanNormalizeError> {
    let plan_value = match args {
        Value::Array(_) => args,
        Value::Object(mut object) => object.remove("plan").ok_or_else(|| {
            PlanNormalizeError::new("finish_plan args must contain a 'plan' array")
        })?,
        other => {
            return Err(PlanNormalizeError::new(format!(
                "finish_plan args must be an object or array, got {}",
                value_type_name(&other)
            )))
        }
    };

    serde_json::from_value::<Vec<RawPlanStep>>(plan_value)
        .map_err(|err| PlanNormalizeError::new(format!("cannot parse finish_plan plan: {err}")))
}

fn resolve_role_id(
    raw_role_id: Option<&str>,
    spec: &TaskSpec,
    role_ids: &HashSet<&str>,
) -> Result<String, PlanNormalizeError> {
    let role_id = raw_role_id.unwrap_or_default().trim();
    if spec.roles.is_empty() {
        return Ok(if role_id.is_empty() {
            "default".to_string()
        } else {
            role_id.to_string()
        });
    }
    if role_id.is_empty() {
        return Err(PlanNormalizeError::new(
            "dispatch step is missing role_id while task roles are defined",
        ));
    }
    if !role_ids.contains(role_id) {
        return Err(PlanNormalizeError::new(format!(
            "unknown role_id '{role_id}'"
        )));
    }
    Ok(role_id.to_string())
}

fn resolve_project(raw_project: Option<&str>, spec: &TaskSpec, fallback_project: &str) -> String {
    let default_project = default_project(spec, fallback_project);
    let Some(project) = raw_project
        .map(str::trim)
        .filter(|project| !project.is_empty())
    else {
        return default_project;
    };

    if !looks_like_project_path(project) {
        return default_project;
    }

    resolve_project_path(project, &default_project)
}

fn default_project(spec: &TaskSpec, fallback_project: &str) -> String {
    spec.project_path
        .as_deref()
        .map(str::trim)
        .filter(|project| !project.is_empty())
        .or_else(|| {
            let fallback = fallback_project.trim();
            (!fallback.is_empty()).then_some(fallback)
        })
        .unwrap_or(".")
        .to_string()
}

fn looks_like_project_path(project: &str) -> bool {
    let project = project.trim();
    project == "."
        || project == ".."
        || project.starts_with("./")
        || project.starts_with(".\\")
        || project.starts_with("../")
        || project.starts_with("..\\")
        || project.starts_with('/')
        || project.starts_with('\\')
        || project.contains('/')
        || project.contains('\\')
        || has_windows_drive_prefix(project)
}

fn resolve_project_path(project: &str, default_project: &str) -> String {
    let project = project.trim();
    if project == "." {
        return default_project.to_string();
    }
    if is_absolute_project_path(project) {
        project.to_string()
    } else {
        format!(
            "{}/{}",
            default_project.trim_end_matches(['/', '\\']),
            project
        )
    }
}

fn project_allowed(project: &str, spec: &TaskSpec, fallback_project: &str) -> bool {
    let project = normalize_project_text(project);
    if project.is_empty() {
        return false;
    }

    let fallback = normalize_project_text(fallback_project);
    if !fallback.is_empty() && project == fallback {
        return true;
    }

    let Some(task_project) = spec.project_path.as_deref() else {
        return fallback.is_empty();
    };
    let task_project = normalize_project_text(task_project);
    if task_project.is_empty() {
        return fallback.is_empty();
    }

    project == task_project || project.starts_with(&format!("{task_project}/"))
}

fn is_absolute_project_path(project: &str) -> bool {
    let project = project.trim();
    project.starts_with('/') || project.starts_with('\\') || has_windows_drive_prefix(project)
}

fn has_windows_drive_prefix(project: &str) -> bool {
    let bytes = project.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

fn normalize_project_text(path: &str) -> String {
    let normalized = normalize_project_components(path);
    if normalized == "." {
        ".".to_string()
    } else {
        normalized
    }
}

fn normalize_project_components(path: &str) -> String {
    let raw = path.trim().replace('\\', "/");
    if raw.is_empty() || raw == "." {
        return raw;
    }

    let (prefix, rest) = if has_windows_drive_prefix(&raw) {
        (raw[..2].to_ascii_lowercase(), raw[2..].to_string())
    } else if raw.starts_with('/') {
        ("/".to_string(), raw.trim_start_matches('/').to_string())
    } else {
        (String::new(), raw)
    };

    let mut parts = Vec::<String>::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if matches!(parts.last().map(String::as_str), Some("..")) || parts.is_empty() {
                    if prefix.is_empty() {
                        parts.push("..".to_string());
                    }
                } else {
                    parts.pop();
                }
            }
            other => parts.push(other.to_ascii_lowercase()),
        }
    }

    if prefix == "/" {
        if parts.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", parts.join("/"))
        }
    } else if prefix.is_empty() {
        if parts.is_empty() {
            ".".to_string()
        } else {
            parts.join("/")
        }
    } else if parts.is_empty() {
        prefix
    } else {
        format!("{prefix}/{}", parts.join("/"))
    }
}

fn dependency_graph_has_cycle(steps: &[Step]) -> bool {
    let mut indegree = HashMap::<&str, usize>::new();
    let mut outgoing = HashMap::<&str, Vec<&str>>::new();

    for step in steps {
        indegree.entry(step.step_id.as_str()).or_insert(0);
    }
    for step in steps {
        for dep in &step.depends_on {
            let dep_id = dep.trim();
            if dep_id.is_empty() || !indegree.contains_key(dep_id) {
                continue;
            }
            outgoing
                .entry(dep_id)
                .or_default()
                .push(step.step_id.as_str());
            *indegree.entry(step.step_id.as_str()).or_insert(0) += 1;
        }
    }

    let mut ready = indegree
        .iter()
        .filter_map(|(step_id, count)| (*count == 0).then_some(*step_id))
        .collect::<VecDeque<_>>();
    let mut visited = 0usize;
    while let Some(step_id) = ready.pop_front() {
        visited += 1;
        if let Some(children) = outgoing.get(step_id) {
            for child in children {
                if let Some(count) = indegree.get_mut(child) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        ready.push_back(child);
                    }
                }
            }
        }
    }

    visited != indegree.len()
}

fn value_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::spec::{AssignmentMode, RoleAssignment, StepKind, TaskKind};
    use serde_json::json;
    use std::collections::HashMap;

    fn spec_with_roles() -> TaskSpec {
        TaskSpec {
            task_id: "ts_plan_doc".into(),
            kind: TaskKind::Plan,
            message: "Implement v0.6 plan".into(),
            project_path: Some("D:/project".into()),
            roles: vec![
                RoleAssignment {
                    role_id: "developer".into(),
                    role_name: "Developer".into(),
                    agent_id: Some("claude-code".into()),
                    responsibilities: vec![],
                    acceptance: vec![],
                    can_edit_files: true,
                    can_run_commands: true,
                    can_receive_rework: true,
                },
                RoleAssignment {
                    role_id: "auditor".into(),
                    role_name: "Auditor".into(),
                    agent_id: Some("codex".into()),
                    responsibilities: vec![],
                    acceptance: vec![],
                    can_edit_files: false,
                    can_run_commands: true,
                    can_receive_rework: false,
                },
            ],
            assignment_mode: AssignmentMode::Manual,
            policy: "default".into(),
            parent_run_id: None,
            epic_id: None,
            depth: 0,
            deadline_ms: Some(120_000),
            labels: HashMap::new(),
            created_at: 1,
        }
    }

    #[test]
    fn normalizes_finish_plan_object_into_typed_steps() {
        let spec = spec_with_roles();
        let steps = normalize_finish_plan(
            json!({
                "plan": [
                    {
                        "step_id": "scope",
                        "type": "dispatch",
                        "role_id": "developer",
                        "prompt": "Clarify implementation scope",
                        "depends_on": [],
                        "project": "D:/project/submodule"
                    },
                    {
                        "step_id": "review",
                        "type": "reflect",
                        "prompt": "Check whether the plan is executable",
                        "depends_on": ["scope"]
                    }
                ]
            }),
            &spec,
            "D:/fallback",
        )
        .expect("finish_plan args should normalize");

        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].step_id, "scope");
        assert_eq!(steps[0].depends_on, Vec::<String>::new());
        assert_eq!(steps[0].timeout_ms, Some(120_000));
        match &steps[0].kind {
            StepKind::Dispatch {
                role_id,
                prompt,
                project,
                session,
            } => {
                assert_eq!(role_id, "developer");
                assert_eq!(prompt, "Clarify implementation scope");
                assert_eq!(project, "D:/project/submodule");
                assert_eq!(session, &None);
            }
            other => panic!("expected dispatch step, got {other:?}"),
        }
        match &steps[1].kind {
            StepKind::Reflect { question } => {
                assert_eq!(question, "Check whether the plan is executable");
            }
            other => panic!("expected reflect step, got {other:?}"),
        }
    }

    #[test]
    fn normalizes_legacy_finish_plan_array() {
        let spec = spec_with_roles();
        let steps = normalize_finish_plan(
            json!([
                {
                    "step_id": "sp_0",
                    "type": "dispatch",
                    "role_id": "developer",
                    "prompt": "Implement the planned change",
                    "depends_on": []
                }
            ]),
            &spec,
            "D:/project",
        )
        .expect("legacy array finish_plan args should normalize");

        assert_eq!(steps.len(), 1);
        match &steps[0].kind {
            StepKind::Dispatch { project, .. } => assert_eq!(project, "D:/project"),
            other => panic!("expected dispatch step, got {other:?}"),
        }
    }

    #[test]
    fn normalizes_bare_project_labels_to_task_project() {
        let spec = spec_with_roles();
        let steps = normalize_finish_plan(
            json!({
                "plan": [
                    {
                        "step_id": "step1_scope",
                        "type": "dispatch",
                        "role_id": "developer",
                        "prompt": "Clarify the unified auth system scope",
                        "depends_on": [],
                        "project": "unified-auth-system"
                    }
                ]
            }),
            &spec,
            "D:/fallback",
        )
        .expect("bare project labels from the LLM should fall back to task project");

        match &steps[0].kind {
            StepKind::Dispatch { project, .. } => assert_eq!(project, "D:/project"),
            other => panic!("expected dispatch step, got {other:?}"),
        }
    }

    #[test]
    fn rejects_duplicate_step_ids() {
        let spec = spec_with_roles();
        let err = normalize_finish_plan(
            json!({
                "plan": [
                    {
                        "step_id": "dup",
                        "type": "dispatch",
                        "role_id": "developer",
                        "prompt": "Do one thing",
                        "depends_on": []
                    },
                    {
                        "step_id": "dup",
                        "type": "reflect",
                        "prompt": "Review the result",
                        "depends_on": []
                    }
                ]
            }),
            &spec,
            "D:/project",
        )
        .expect_err("duplicate step ids must be rejected");

        assert!(err.to_string().contains("duplicate step_id"));
    }

    #[test]
    fn rejects_unknown_role() {
        let spec = spec_with_roles();
        let err = normalize_finish_plan(
            json!({
                "plan": [
                    {
                        "step_id": "sp_0",
                        "type": "dispatch",
                        "role_id": "designer",
                        "prompt": "Design the implementation",
                        "depends_on": []
                    }
                ]
            }),
            &spec,
            "D:/project",
        )
        .expect_err("unknown role_id must be rejected");

        assert!(err.to_string().contains("unknown role_id"));
    }

    #[test]
    fn rejects_dependency_cycles() {
        let spec = spec_with_roles();
        let err = normalize_finish_plan(
            json!({
                "plan": [
                    {
                        "step_id": "a",
                        "type": "dispatch",
                        "role_id": "developer",
                        "prompt": "Do A",
                        "depends_on": ["b"]
                    },
                    {
                        "step_id": "b",
                        "type": "reflect",
                        "prompt": "Review B",
                        "depends_on": ["a"]
                    }
                ]
            }),
            &spec,
            "D:/project",
        )
        .expect_err("dependency cycles must be rejected");

        assert!(err.to_string().contains("cycle"));
    }

    #[test]
    fn rejects_dispatch_project_outside_task_project() {
        let spec = spec_with_roles();
        let err = normalize_finish_plan(
            json!({
                "plan": [
                    {
                        "step_id": "sp_0",
                        "type": "dispatch",
                        "role_id": "developer",
                        "prompt": "Implement the planned change",
                        "depends_on": [],
                        "project": "D:/other-project"
                    }
                ]
            }),
            &spec,
            "D:/fallback",
        )
        .expect_err("dispatch projects outside the task project must be rejected");

        assert!(err.to_string().contains("outside task project"));
    }
}
