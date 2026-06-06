use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Core task specification submitted by HUB or CLI.
///
/// v0.6 non-compatible redesign: no legacy fields, no `#[serde(default)]` compat.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSpec {
    pub task_id: String,
    pub kind: TaskKind,
    pub message: String,
    pub project_path: Option<String>,
    pub roles: Vec<RoleAssignment>,
    pub assignment_mode: AssignmentMode,
    pub policy: String,
    pub parent_run_id: Option<String>,
    pub epic_id: Option<String>,
    pub depth: u8,
    pub deadline_ms: Option<u64>,
    pub labels: HashMap<String, String>,
    pub created_at: i64,
}

/// How agent assignments are determined for roles.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentMode {
    /// User explicitly assigns agents to each role (default).
    #[default]
    Manual,
    /// System suggests agents, user confirms before submission.
    AutoSuggest,
    /// System automatically assigns agents (future: v0.7+).
    AutoApply,
}

/// A single role within a task, with its assigned agent (optional in auto modes).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoleAssignment {
    pub role_id: String,
    pub role_name: String,
    /// Manual mode: must be set. AutoSuggest/AutoApply: may be empty.
    pub agent_id: Option<String>,
    pub responsibilities: Vec<String>,
    pub acceptance: Vec<String>,
    pub can_edit_files: bool,
    pub can_run_commands: bool,
    pub can_receive_rework: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Chat,
    Run,
    Evolve,
    Plan,
}

/// A single step in a run plan. Steps execute sequentially by default;
/// `depends_on` enables DAG-style ordering for future parallel execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub step_id: String,
    pub kind: StepKind,
    pub depends_on: Vec<String>,
    pub timeout_ms: Option<u64>,
}

/// Typed step kinds — no string parsing at runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StepKind {
    /// Dispatch work to a role (resolved to agent by worker at runtime).
    Dispatch {
        /// References a RoleAssignment.role_id in the spec.
        role_id: String,
        /// Full prompt for the agent.
        prompt: String,
        /// Working directory (defaults to spec.project_path).
        project: String,
        /// Resume an existing agent session (optional).
        session: Option<String>,
    },
    /// Run a shell command within the project directory.
    Shell {
        command: String,
        /// Must resolve inside spec.project_path (enforced by dispatcher).
        cwd: PathBuf,
        timeout_ms: Option<u64>,
    },
    /// Read a file within the project directory.
    Read {
        /// Must resolve inside spec.project_path (enforced by dispatcher).
        path: PathBuf,
        /// Max bytes to read (default 1MB).
        max_bytes: u64,
    },
    /// Write a file. If `requires_approval` is true, step pauses for user review.
    Write {
        /// Must resolve inside spec.project_path (enforced by dispatcher).
        path: PathBuf,
        content: String,
        /// true → step status = awaiting_approval, file NOT written until approved.
        requires_approval: bool,
    },
    /// Ask the DecisionEngine (jishu-self LLM) a question about run state.
    Reflect { question: String },
    /// Verify a condition — strongly typed, no string parsing.
    Verify { check: VerifyCheck },
}

/// Strongly typed verification checks — replaces stringly-typed check/expect.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VerifyCheck {
    FileExists { path: PathBuf },
    CommandSuccess { command: String },
    OutputContains { command: String, substring: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_spec_roundtrip_v0_6() {
        let spec = TaskSpec {
            task_id: "ts_v6_test".into(),
            kind: TaskKind::Run,
            message: "Implement the feature".into(),
            project_path: Some("/project".into()),
            roles: vec![
                RoleAssignment {
                    role_id: "developer".into(),
                    role_name: "Developer".into(),
                    agent_id: Some("claude-code".into()),
                    responsibilities: vec!["Write code".into()],
                    acceptance: vec!["Tests pass".into()],
                    can_edit_files: true,
                    can_run_commands: true,
                    can_receive_rework: true,
                },
                RoleAssignment {
                    role_id: "auditor".into(),
                    role_name: "Auditor".into(),
                    agent_id: Some("codex".into()),
                    responsibilities: vec!["Review code".into()],
                    acceptance: vec!["No P0/P1 issues".into()],
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
            deadline_ms: None,
            labels: HashMap::new(),
            created_at: 1700000000,
        };
        let json = serde_json::to_string(&spec).unwrap();
        let de: TaskSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(spec.task_id, de.task_id);
        assert_eq!(de.roles.len(), 2);
        assert_eq!(de.roles[0].agent_id, Some("claude-code".into()));
        assert_eq!(de.roles[1].agent_id, Some("codex".into()));
        assert_eq!(de.assignment_mode, AssignmentMode::Manual);
    }

    #[test]
    fn task_spec_without_agents_auto_mode() {
        let spec = TaskSpec {
            task_id: "ts_auto".into(),
            kind: TaskKind::Run,
            message: "Auto assign this".into(),
            project_path: Some("/project".into()),
            roles: vec![RoleAssignment {
                role_id: "dev".into(),
                role_name: "Developer".into(),
                agent_id: None, // Auto mode: no agent assigned yet
                responsibilities: vec![],
                acceptance: vec![],
                can_edit_files: true,
                can_run_commands: true,
                can_receive_rework: false,
            }],
            assignment_mode: AssignmentMode::AutoSuggest,
            policy: "default".into(),
            parent_run_id: None,
            epic_id: None,
            depth: 0,
            deadline_ms: None,
            labels: HashMap::new(),
            created_at: 1,
        };
        let json = serde_json::to_string(&spec).unwrap();
        let de: TaskSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(de.roles[0].agent_id, None);
        assert_eq!(de.assignment_mode, AssignmentMode::AutoSuggest);
    }

    #[test]
    fn step_kind_dispatch_uses_role_id() {
        let step = Step {
            step_id: "sp_0".into(),
            kind: StepKind::Dispatch {
                role_id: "developer".into(),
                prompt: "Implement feature X".into(),
                project: "/tmp".into(),
                session: None,
            },
            depends_on: vec![],
            timeout_ms: None,
        };
        let json = serde_json::to_string(&step).unwrap();
        assert!(json.contains("\"type\":\"dispatch\""));
        assert!(json.contains("\"role_id\":\"developer\""));
        assert!(!json.contains("\"agent\"")); // No more "agent" field

        let de: Step = serde_json::from_str(&json).unwrap();
        assert_eq!(step.step_id, de.step_id);
    }

    #[test]
    fn verify_check_strong_typing() {
        let checks = vec![
            VerifyCheck::FileExists {
                path: PathBuf::from("/project/src/main.rs"),
            },
            VerifyCheck::CommandSuccess {
                command: "cargo test".into(),
            },
            VerifyCheck::OutputContains {
                command: "cargo clippy".into(),
                substring: "error".into(),
            },
        ];
        for check in &checks {
            let json = serde_json::to_string(check).unwrap();
            let de: VerifyCheck = serde_json::from_str(&json).unwrap();
            assert_eq!(
                serde_json::to_string(check).unwrap(),
                serde_json::to_string(&de).unwrap()
            );
        }
    }

    #[test]
    fn write_step_requires_approval() {
        let step = Step {
            step_id: "sp_write".into(),
            kind: StepKind::Write {
                path: PathBuf::from("/project/README.md"),
                content: "# Hello".into(),
                requires_approval: true,
            },
            depends_on: vec![],
            timeout_ms: None,
        };
        let json = serde_json::to_string(&step).unwrap();
        assert!(json.contains("\"requires_approval\":true"));
        let de: Step = serde_json::from_str(&json).unwrap();
        assert_eq!(step.step_id, de.step_id);
    }

    #[test]
    fn shell_step_with_timeout() {
        let step = Step {
            step_id: "sp_shell".into(),
            kind: StepKind::Shell {
                command: "cargo build".into(),
                cwd: PathBuf::from("/project"),
                timeout_ms: Some(60_000),
            },
            depends_on: vec![],
            timeout_ms: None,
        };
        let json = serde_json::to_string(&step).unwrap();
        let de: Step = serde_json::from_str(&json).unwrap();
        assert_eq!(step.step_id, de.step_id);
    }

    #[test]
    fn read_step_with_max_bytes() {
        let step = Step {
            step_id: "sp_read".into(),
            kind: StepKind::Read {
                path: PathBuf::from("/project/Cargo.toml"),
                max_bytes: 1024,
            },
            depends_on: vec![],
            timeout_ms: None,
        };
        let json = serde_json::to_string(&step).unwrap();
        assert!(json.contains("\"max_bytes\":1024"));
        let de: Step = serde_json::from_str(&json).unwrap();
        assert_eq!(step.step_id, de.step_id);
    }
}
