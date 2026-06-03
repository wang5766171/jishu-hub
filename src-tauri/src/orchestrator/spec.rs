use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSpec {
    pub task_id: String,
    pub kind: TaskKind,
    pub message: String,
    pub project_path: Option<String>,
    pub agent_hint: Option<String>,
    #[serde(default)]
    pub roles: Vec<RoleAssignment>,
    pub policy: String,
    pub depth: u8,
    pub parent_task_id: Option<String>,
    pub created_at: i64,
    pub deadline_ms: Option<u64>,
    pub labels: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoleAssignment {
    pub role_id: String,
    pub role_name: String,
    pub agent_id: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Chat,
    Run,
    Evolve,
    Plan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub step_id: String,
    pub kind: StepKind,
    pub depends_on: Vec<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StepKind {
    Dispatch {
        agent: String,
        message: String,
        project: String,
        session: Option<String>,
    },
    Shell {
        command: String,
        cwd: PathBuf,
    },
    Read {
        path: PathBuf,
    },
    Write {
        path: PathBuf,
        content: String,
    },
    Reflect {
        question: String,
    },
    Verify {
        check: String,
        expect: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_spec_preserves_hub_role_assignments() {
        let json = serde_json::json!({
            "task_id": "ts_roles",
            "kind": "plan",
            "message": "Ship the feature",
            "project_path": ".",
            "agent_hint": null,
            "policy": "default",
            "depth": 0,
            "parent_task_id": null,
            "created_at": 1,
            "deadline_ms": null,
            "labels": {},
            "roles": [
                {
                    "role_id": "architect",
                    "role_name": "架构师",
                    "agent_id": "claude1",
                    "responsibilities": ["架构设计"],
                    "acceptance": ["设计文档完成"],
                    "can_edit_files": false,
                    "can_run_commands": false,
                    "can_receive_rework": true
                },
                {
                    "role_id": "auditor",
                    "role_name": "审计员",
                    "agent_id": "codex",
                    "responsibilities": ["最终审计"],
                    "acceptance": ["无 P0/P1 问题"],
                    "can_edit_files": false,
                    "can_run_commands": true,
                    "can_receive_rework": false
                }
            ]
        });

        let spec: TaskSpec = serde_json::from_value(json).unwrap();

        assert_eq!(spec.roles.len(), 2);
        assert_eq!(spec.roles[0].role_id, "architect");
        assert_eq!(spec.roles[0].agent_id, "claude1");
        assert_eq!(spec.roles[1].role_name, "审计员");
        assert!(!spec.roles[1].can_receive_rework);
    }
}
