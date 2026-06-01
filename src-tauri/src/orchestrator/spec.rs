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
    pub policy: String,
    pub depth: u8,
    pub parent_task_id: Option<String>,
    pub created_at: i64,
    pub deadline_ms: Option<u64>,
    pub labels: HashMap<String, String>,
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
