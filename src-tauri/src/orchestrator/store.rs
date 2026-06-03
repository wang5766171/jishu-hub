use crate::agent::NormalizedEvent;
use crate::orchestrator::rework::ReworkItem;
use crate::orchestrator::result::{RunResult, RunStatus};
use crate::orchestrator::spec::{Step, TaskSpec};
use serde::de::DeserializeOwned;
use std::path::{Path, PathBuf};

/// Persistent storage for run state. All I/O is synchronous (file-based).
///
/// Directory layout per run:
/// ```text
/// ~/.jishu-hub/runs/<run_id>/
/// ├── spec.json
/// ├── plan.json
/// ├── result.json
/// ├── trace.jsonl
/// └── rework.json    (optional, for parent runs)
/// ```
pub struct RunStore {
    root: PathBuf,
}

impl RunStore {
    /// Open the default store at `~/.jishu-hub/runs/`.
    pub fn open() -> Result<Self, String> {
        let root = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".jishu-hub")
            .join("runs");
        Self::open_at(root)
    }

    /// Open a store at an explicit root (for testing).
    pub fn open_at(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    // ── Write operations ──────────────────────────────────────────────────

    /// Create a new run directory and write the spec.
    /// Returns the run directory path.
    pub fn create_run(&self, run_id: &str, spec: &TaskSpec) -> Result<PathBuf, String> {
        let run_dir = self.run_dir(run_id);
        std::fs::create_dir_all(&run_dir).map_err(|e| e.to_string())?;
        self.write_json(&run_dir.join("spec.json"), spec)?;
        Ok(run_dir)
    }

    pub fn write_plan(&self, run_id: &str, steps: &[Step]) -> Result<(), String> {
        self.write_json(&self.run_dir(run_id).join("plan.json"), steps)
    }

    pub fn write_result(&self, run_id: &str, result: &RunResult) -> Result<(), String> {
        self.write_json(&self.run_dir(run_id).join("result.json"), result)
    }

    pub fn write_rework(&self, run_id: &str, items: &[ReworkItem]) -> Result<(), String> {
        self.write_json(&self.run_dir(run_id).join("rework.json"), items)
    }

    /// Append a single raw event to trace.jsonl.
    pub fn append_trace(&self, run_id: &str, event: &NormalizedEvent) -> Result<(), String> {
        let path = self.run_dir(run_id).join("trace.jsonl");
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        let mut line = serde_json::to_string(event).map_err(|e| e.to_string())?;
        line.push('\n');
        use std::io::Write;
        file.write_all(line.as_bytes()).map_err(|e| e.to_string())
    }

    // ── Read operations ───────────────────────────────────────────────────

    pub fn read_spec(&self, run_id: &str) -> Result<TaskSpec, String> {
        self.read_json(&self.run_dir(run_id).join("spec.json"))
    }

    pub fn read_plan(&self, run_id: &str) -> Result<Vec<Step>, String> {
        self.read_json(&self.run_dir(run_id).join("plan.json"))
    }

    pub fn read_result(&self, run_id: &str) -> Result<RunResult, String> {
        self.read_json(&self.run_dir(run_id).join("result.json"))
    }

    pub fn read_rework(&self, run_id: &str) -> Result<Vec<ReworkItem>, String> {
        let path = self.run_dir(run_id).join("rework.json");
        if !path.exists() {
            return Ok(Vec::new());
        }
        self.read_json(&path)
    }

    pub fn read_trace(&self, run_id: &str) -> Result<Vec<NormalizedEvent>, String> {
        let path = self.run_dir(run_id).join("trace.jsonl");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let content =
            std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut events = Vec::new();
        for line in content.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(event) = serde_json::from_str::<NormalizedEvent>(line) {
                events.push(event);
            }
        }
        Ok(events)
    }

    /// Check whether a run directory exists.
    pub fn run_exists(&self, run_id: &str) -> bool {
        self.run_dir(run_id).join("spec.json").exists()
    }

    // ── List operations ───────────────────────────────────────────────────

    /// List all runs, most recent first.
    pub fn list_runs(&self) -> Result<Vec<RunSummary>, String> {
        let mut runs = Vec::new();
        let entries = match std::fs::read_dir(&self.root) {
            Ok(e) => e,
            Err(_) => return Ok(runs),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let run_id = entry.file_name().to_string_lossy().to_string();
            let spec_path = path.join("spec.json");
            let result_path = path.join("result.json");
            if !spec_path.exists() || !result_path.exists() {
                continue;
            }
            let spec: TaskSpec = match self.read_json(&spec_path) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("store: skipping run {}, spec parse error: {e}", run_id);
                    continue;
                }
            };
            let result: RunResult = match self.read_json(&result_path) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("store: skipping run {}, result parse error: {e}", run_id);
                    continue;
                }
            };
            runs.push(RunSummary {
                run_id,
                task_id: result.task_id,
                status: result.status,
                started_at: result.started_at,
                finished_at: result.finished_at,
                title: spec.message,
            });
        }
        runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(runs)
    }

    /// List runs that are not in a terminal state (for restart recovery).
    pub fn unfinished_runs(&self) -> Result<Vec<RunSummary>, String> {
        Ok(self
            .list_runs()?
            .into_iter()
            .filter(|r| !r.status.is_terminal())
            .collect())
    }

    /// List runs that have a given parent_run_id in their spec.
    pub fn list_runs_with_parent(&self, parent_run_id: &str) -> Result<Vec<RunSummary>, String> {
        Ok(self
            .list_runs()?
            .into_iter()
            .filter(|r| {
                // Read the spec to check parent_run_id
                self.read_spec(&r.run_id)
                    .map(|s| s.parent_run_id.as_deref() == Some(parent_run_id))
                    .unwrap_or(false)
            })
            .collect())
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    fn run_dir(&self, run_id: &str) -> PathBuf {
        self.root.join(run_id)
    }

    fn write_json<T: serde::Serialize + ?Sized>(&self, path: &Path, data: &T) -> Result<(), String> {
        let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    fn read_json<T: DeserializeOwned>(&self, path: &Path) -> Result<T, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Cannot parse {}: {e}", path.display()))
    }
}

/// Lightweight summary for listing — no need to load full run data.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RunSummary {
    pub run_id: String,
    pub task_id: String,
    pub status: RunStatus,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub title: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::spec::{AssignmentMode, TaskKind};
    use std::collections::HashMap;

    fn test_store() -> (RunStore, PathBuf) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("jishu_store_test_{}_{}", std::process::id(), id));
        let _ = std::fs::remove_dir_all(&root);
        let store = RunStore::open_at(root.clone()).unwrap();
        (store, root)
    }

    fn make_spec(task_id: &str) -> TaskSpec {
        TaskSpec {
            task_id: task_id.into(),
            kind: TaskKind::Plan,
            message: format!("Test task {task_id}"),
            project_path: Some("/project".into()),
            roles: vec![],
            assignment_mode: AssignmentMode::Manual,
            policy: "default".into(),
            parent_run_id: None,
            epic_id: None,
            depth: 0,
            deadline_ms: None,
            labels: HashMap::new(),
            created_at: 1700000000,
        }
    }

    #[test]
    fn create_run_and_read_spec() {
        let (store, root) = test_store();
        let spec = make_spec("ts_store_1");
        let run_dir = store.create_run("r_001", &spec).unwrap();
        assert!(run_dir.join("spec.json").exists());

        let read_back = store.read_spec("r_001").unwrap();
        assert_eq!(read_back.task_id, "ts_store_1");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_and_read_plan() {
        let (store, root) = test_store();
        let spec = make_spec("ts_plan");
        store.create_run("r_plan", &spec).unwrap();

        let steps = vec![crate::orchestrator::spec::Step {
            step_id: "sp_0".into(),
            kind: crate::orchestrator::spec::StepKind::Dispatch {
                role_id: "dev".into(),
                prompt: "Do work".into(),
                project: "/project".into(),
                session: None,
            },
            depends_on: vec![],
            timeout_ms: None,
        }];
        store.write_plan("r_plan", &steps).unwrap();
        let read_back = store.read_plan("r_plan").unwrap();
        assert_eq!(read_back.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_and_read_result() {
        let (store, root) = test_store();
        let spec = make_spec("ts_result");
        store.create_run("r_result", &spec).unwrap();

        let result = RunResult {
            run_id: "r_result".into(),
            task_id: "ts_result".into(),
            status: RunStatus::Complete,
            started_at: 1700000000,
            finished_at: Some(1700000060),
            steps: vec![],
            usage: crate::orchestrator::result::UsageSummary::zero(),
            error: None,
            cost_usd: None,
            summary: None,
        };
        store.write_result("r_result", &result).unwrap();
        let read_back = store.read_result("r_result").unwrap();
        assert_eq!(read_back.status, RunStatus::Complete);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn append_trace_events() {
        let (store, root) = test_store();
        let spec = make_spec("ts_trace");
        store.create_run("r_trace", &spec).unwrap();

        store
            .append_trace(
                "r_trace",
                &NormalizedEvent::TextDelta {
                    delta: "hello".into(),
                },
            )
            .unwrap();
        store
            .append_trace(
                "r_trace",
                &NormalizedEvent::TextDelta {
                    delta: "world".into(),
                },
            )
            .unwrap();

        let events = store.read_trace("r_trace").unwrap();
        assert_eq!(events.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_runs_returns_all() {
        let (store, root) = test_store();
        for i in 0..3 {
            let spec = make_spec(&format!("ts_list_{i}"));
            store.create_run(&format!("r_list_{i}"), &spec).unwrap();
            let result = RunResult {
                run_id: format!("r_list_{i}"),
                task_id: format!("ts_list_{i}"),
                status: RunStatus::Complete,
                started_at: 1700000000 + i as i64,
                finished_at: Some(1700000060),
                steps: vec![],
                usage: crate::orchestrator::result::UsageSummary::zero(),
                error: None,
                cost_usd: None,
                summary: None,
            };
            store
                .write_result(&format!("r_list_{i}"), &result)
                .unwrap();
        }

        let runs = store.list_runs().unwrap();
        assert_eq!(runs.len(), 3);
        // Most recent first
        assert_eq!(runs[0].run_id, "r_list_2");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unfinished_runs_filters_terminal() {
        let (store, root) = test_store();

        // Running run
        let spec = make_spec("ts_unfin");
        store.create_run("r_running", &spec).unwrap();
        store
            .write_result(
                "r_running",
                &RunResult {
                    run_id: "r_running".into(),
                    task_id: "ts_unfin".into(),
                    status: RunStatus::Running,
                    started_at: 1,
                    finished_at: None,
                    steps: vec![],
                    usage: crate::orchestrator::result::UsageSummary::zero(),
                    error: None,
                    cost_usd: None,
                    summary: None,
                },
            )
            .unwrap();

        // Complete run
        let spec2 = make_spec("ts_done");
        store.create_run("r_complete", &spec2).unwrap();
        store
            .write_result(
                "r_complete",
                &RunResult {
                    run_id: "r_complete".into(),
                    task_id: "ts_done".into(),
                    status: RunStatus::Complete,
                    started_at: 1,
                    finished_at: Some(2),
                    steps: vec![],
                    usage: crate::orchestrator::result::UsageSummary::zero(),
                    error: None,
                    cost_usd: None,
                    summary: None,
                },
            )
            .unwrap();

        let unfinished = store.unfinished_runs().unwrap();
        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].run_id, "r_running");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_rework_returns_empty_when_no_file() {
        let (store, root) = test_store();
        let spec = make_spec("ts_rework_empty");
        store.create_run("r_rework_empty", &spec).unwrap();
        let items = store.read_rework("r_rework_empty").unwrap();
        assert!(items.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
