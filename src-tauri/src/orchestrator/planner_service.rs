//! jishu agent runtime for plan generation.
//!
//! Drives a multi-turn LLM conversation that:
//! 1. Invokes `load_skill` tool to get the chosen task-plan skill's
//!    role contracts.
//! 2. Streams a plan draft (text + tool_use events) to the HUB.
//! 3. Calls `finish_plan` tool to commit the plan to disk.
//!
//! The HUB subscribes to a per-run event channel. It can also
//! cancel the run or send supplement messages (LLM continues).

use crate::llm::agent_loop::{run_tool_loop, AgentEvent, AgentLoopConfig, ToolDef};
use crate::llm::CancelToken;
use crate::orchestrator::now_ms;
use crate::orchestrator::plan_document::PlanDocument;
use crate::orchestrator::result::RunStatus;
use crate::orchestrator::RunStore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

pub type AsyncToolHandler = Arc<
    dyn Fn(
            serde_json::Value,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>>
        + Send
        + Sync,
>;

/// Persisted state — written to plan_state.json in the run dir.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanState {
    pub run_id: String,
    pub plan_session_id: String,
    pub skill_id: Option<String>,
    pub status: PlanStatus,
    pub plan: Option<serde_json::Value>,
    pub last_event_ms: i64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Pending,
    Generating,
    Cancelled,
    PlanReady,
    Committed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlannerEvent {
    TextDelta(String),
    ToolCallStarted {
        name: String,
        arguments: serde_json::Value,
    },
    ToolCallFinished {
        name: String,
        result: String,
        is_error: bool,
    },
    PlanReady(serde_json::Value),
    Done {
        status: PlanStatus,
        error: Option<String>,
    },
}

/// Live JishuPlannerService for one run. Holds shared state + cancel token +
/// an events channel the HUB subscribes to.
pub struct JishuPlannerService {
    pub state: Arc<Mutex<PlanState>>,
    pub cancel: CancelToken,
    pub events_tx: mpsc::UnboundedSender<PlannerEvent>,
}

/// Global registry of live plan agents, keyed by run_id.
pub type PlanRegistry = Arc<std::sync::Mutex<HashMap<String, Arc<JishuPlannerService>>>>;

static GLOBAL_PLANS: std::sync::OnceLock<PlanRegistry> = std::sync::OnceLock::new();

pub fn global_plans() -> &'static PlanRegistry {
    GLOBAL_PLANS.get_or_init(|| Arc::new(std::sync::Mutex::new(HashMap::new())))
}

pub fn register(plan: Arc<JishuPlannerService>) {
    let key = plan.state.clone();
    // The state is a tokio Mutex; use blocking snapshot to extract run_id.
    let key_id = snapshot_state(&key).run_id;
    global_plans().lock().unwrap().insert(key_id, plan);
}

pub fn unregister(run_id: &str) {
    global_plans().lock().unwrap().remove(run_id);
}

pub fn get(run_id: &str) -> Option<Arc<JishuPlannerService>> {
    global_plans().lock().unwrap().get(run_id).cloned()
}

pub fn cancel_agent(run_id: &str) {
    if let Some(agent) = get(run_id) {
        agent.cancel.cancel();
    }
}

/// Block-on the async state mutex via a one-shot current-thread
/// runtime. Used by sync callers (e.g. IPC) to snapshot PlanState.
pub fn snapshot_state(state: &Arc<Mutex<PlanState>>) -> PlanState {
    let state_clone = state.clone();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .or_else(|_| tokio::runtime::Runtime::new())
        .expect("Failed to build tokio runtime");
    rt.block_on(async move { state_clone.lock().await.clone() })
}

/// Read plan_state.json from disk (for restart-attached state).
pub fn read_state_from_disk(run_id: &str) -> Option<PlanState> {
    if let Ok(store) = RunStore::open() {
        store
            .read_plan_state(run_id)
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_value(v).ok())
    } else {
        None
    }
}

/// Write current PlanState to plan_state.json
pub fn persist_state(run_id: &str, state: &PlanState) {
    if let Ok(store) = RunStore::open() {
        persist_state_with_store(&store, run_id, state);
    }
}

pub fn persist_state_in_root(root: &Path, run_id: &str, state: &PlanState) {
    if let Ok(store) = RunStore::open_at(root.to_path_buf()) {
        persist_state_with_store(&store, run_id, state);
    }
}

fn persist_state_with_store(store: &RunStore, run_id: &str, state: &PlanState) {
    if let Ok(val) = serde_json::to_value(state) {
        let _ = store.write_plan_state(run_id, &val);
    }
}

trait TokioBlockingExt {
    type Output;
    fn blocking_lock_owned(&self) -> Self::Output;
}

impl<T> TokioBlockingExt for Arc<Mutex<T>> {
    type Output = tokio::sync::OwnedMutexGuard<T>;
    fn blocking_lock_owned(&self) -> Self::Output {
        self.clone().blocking_lock_owned()
    }
}

/// Build the system prompt for the jishu agent.
pub fn system_prompt(task: &str, skill_id: &str) -> String {
    format!(
        "You are the jishu agent — a planning assistant. The user gave you \
         a task to break down into an executable orchestration plan.\n\n\
         Selected skill: `{skill_id}`.\n\
         First, call the `load_skill` tool with skill_id=\"{skill_id}\" \
         to load the skill's role contracts. Then design steps that fit \
         the user's task using those roles.\n\n\
         Rules:\n\
         - Use only the roles defined by the loaded skill.\n\
         - Each step has: step_id, type (dispatch|reflect), role_id, prompt, depends_on.\n\
         - `project` is optional and means execution working directory only. Omit it unless you know an exact path under the task project. Never put a business/product/system name in `project`.\n\
         - First step should be scope/clarification. Last step should be a Reflect.\n\
         - Stream your plan as prose (text_delta events). When the plan structure is complete, call `finish_plan` with an object containing the full plan.\n\
         - The finish_plan argument must be: {{\"plan\": [{{step_id, type, role_id, prompt, depends_on, project}}]}}.\n\n\
         User's task:\n\n{task}\n"
    )
}

/// Build the tool list — load_skill + finish_plan.
pub fn build_tools(skill_id: &str) -> Vec<ToolDef> {
    let skill_id_owned = skill_id.to_string();

    let load_skill_handler: AsyncToolHandler = Arc::new(move |_args: serde_json::Value| {
        let skill_id_inner = skill_id_owned.clone();
        Box::pin(async move {
            let dir = crate::task_plan::task_plan_dir()
                .map_err(|e| format!("Cannot locate task-plan dir: {e}"))?;
            let skill = crate::task_plan::read_installed_skill(&dir, &skill_id_inner)
                .map_err(|e| format!("read_installed_skill: {e}"))?
                .ok_or_else(|| format!("Skill '{skill_id_inner}' not installed"))?;
            if !skill.valid {
                return Err(skill
                    .error
                    .unwrap_or_else(|| "Skill is invalid".to_string()));
            }
            let manifest = serde_json::json!({
                "skill_id": skill_id_inner,
                "name": skill.name,
                "description": skill.description,
                "workflow_hints": skill.workflow_hints,
                "roles": skill.roles,
            });
            serde_json::to_string_pretty(&manifest).map_err(|e| format!("Serialize: {e}"))
        })
    });

    let finish_plan_handler: AsyncToolHandler = Arc::new(move |args: serde_json::Value| {
        let _args = args;
        Box::pin(async move { Ok(serde_json::to_string(&_args).unwrap_or_default()) })
    });

    vec![
        ToolDef {
            name: "load_skill".to_string(),
            description: "Load a task-plan skill's role contracts and workflow hints. \
                         Call this first to understand the available roles."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "skill_id": { "type": "string", "description": "The skill identifier" }
                },
                "required": ["skill_id"]
            }),
            handler: load_skill_handler,
        },
        ToolDef {
            name: "finish_plan".to_string(),
            description: "Commit the final plan. Call this with the complete plan \
                         object when done drafting."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "plan": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "step_id": { "type": "string" },
                                "type": { "type": "string", "enum": ["dispatch", "reflect"] },
                                "role_id": { "type": "string" },
                                "prompt": { "type": "string" },
                                "depends_on": { "type": "array", "items": { "type": "string" } },
                                "project": {
                                    "type": "string",
                                    "description": "Optional execution working directory. Omit unless it is an exact path under the task project; do not use business/product/system names."
                                }
                            }
                        }
                    }
                },
                "required": ["plan"]
            }),
            handler: finish_plan_handler,
        },
    ]
}

pub fn commit_finished_plan_in_root(
    root: &Path,
    run_id: &str,
    skill_id: Option<String>,
    raw_finish_plan_args: serde_json::Value,
) -> Result<PlanDocument, String> {
    let store = RunStore::open_at(root.to_path_buf())?;
    let spec = store.read_spec(run_id)?;
    let revision = store
        .read_plan_document(run_id)?
        .map(|document| document.revision + 1)
        .unwrap_or(1);
    let fallback_project = spec.project_path.as_deref().unwrap_or(".");
    let document = PlanDocument::ready_from_finish_plan(
        run_id.to_string(),
        skill_id,
        revision,
        raw_finish_plan_args,
        &spec,
        fallback_project,
        now_ms(),
    )
    .map_err(|err| err.to_string())?;

    store.write_plan(run_id, &document.steps)?;
    if let Some(draft) = &document.draft {
        store.write_plan_draft(run_id, draft)?;
    }
    store.write_plan_document(run_id, &document)?;
    update_run_result_with_store(&store, run_id, RunStatus::Complete, None)?;
    Ok(document)
}

fn update_run_result_in_root(root: &Path, run_id: &str, status: RunStatus, error: Option<String>) {
    if let Ok(store) = RunStore::open_at(root.to_path_buf()) {
        let _ = update_run_result_with_store(&store, run_id, status, error);
    }
}

fn update_run_result_with_store(
    store: &RunStore,
    run_id: &str,
    status: RunStatus,
    error: Option<String>,
) -> Result<(), String> {
    let mut result = store.read_result(run_id)?;
    result.status = status;
    result.finished_at = Some(now_ms());
    result.error = error;
    store.write_result(run_id, &result)
}

/// Start a JishuPlannerService for a run. Spawns a dedicated background thread
/// (with its own tokio runtime) so it can be invoked from any caller —
/// sync Tauri command, test, CLI, daemon — without depending on the
/// caller's thread having a tokio runtime entered.
pub fn start(
    run_id: String,
    skill_id: String,
    initial_user_prompt: String,
) -> Result<Arc<JishuPlannerService>, String> {
    let store = RunStore::open()?;
    start_in_root(
        run_id,
        skill_id,
        initial_user_prompt,
        store.root().to_path_buf(),
    )
}

pub fn start_in_root(
    run_id: String,
    skill_id: String,
    initial_user_prompt: String,
    store_root: PathBuf,
) -> Result<Arc<JishuPlannerService>, String> {
    let plan_session_id = format!("plan_{}", now_ms());
    let state = Arc::new(Mutex::new(PlanState {
        run_id: run_id.clone(),
        plan_session_id: plan_session_id.clone(),
        skill_id: Some(skill_id.clone()),
        status: PlanStatus::Pending,
        plan: None,
        last_event_ms: now_ms(),
        error: None,
    }));

    let cancel = CancelToken::new();
    let (events_tx, _events_rx) = mpsc::unbounded_channel::<PlannerEvent>();

    let agent = Arc::new(JishuPlannerService {
        state: state.clone(),
        cancel: cancel.clone(),
        events_tx: events_tx.clone(),
    });

    // Persist initial state via a one-shot current_thread runtime so we
    // don't depend on a tokio runtime being entered here.
    {
        let state_for_persist = state.clone();
        let run_id_for_persist = run_id.clone();
        let store_root_for_persist = store_root.clone();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("Failed to build tokio runtime: {e}"))?;
        rt.block_on(async move {
            let g = state_for_persist.lock().await;
            persist_state_in_root(&store_root_for_persist, &run_id_for_persist, &*g);
        });
    }

    register(agent.clone());

    // Spawn dedicated background thread with its own tokio runtime.
    let state_for_task = state.clone();
    let events_tx_for_task = events_tx.clone();
    let cancel_for_task = cancel.clone();
    let run_id_for_task = run_id.clone();
    let skill_id_for_task = skill_id.clone();
    let initial_user_prompt_for_task = initial_user_prompt.clone();
    let store_root_for_task = store_root.clone();

    std::thread::Builder::new()
        .name(format!("plan-agent-{}", run_id_for_task))
        .spawn(move || {
            let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                let err_msg = "Failed to build tokio runtime".to_string();
                {
                    let mut g = state_for_task.blocking_lock();
                    g.status = PlanStatus::Failed;
                    g.error = Some(err_msg.clone());
                    g.last_event_ms = now_ms();
                    persist_state_in_root(&store_root_for_task, &run_id_for_task, &*g);
                }
                update_run_result_in_root(
                    &store_root_for_task,
                    &run_id_for_task,
                    RunStatus::Error,
                    Some(err_msg.clone()),
                );
                let _ = events_tx_for_task.send(PlannerEvent::Done {
                    status: PlanStatus::Failed,
                    error: Some(err_msg),
                });
                unregister(&run_id_for_task);
                return;
            };
            rt.block_on(async move {
        // Update status
        {
            let mut g = state_for_task.lock().await;
            g.status = PlanStatus::Generating;
            g.last_event_ms = now_ms();
        }
        {
            let g = state_for_task.lock().await;
            persist_state_in_root(&store_root_for_task, &run_id_for_task, &*g);
        }

        let tools = build_tools(&skill_id_for_task);
        let cfg = AgentLoopConfig {
            system_prompt: system_prompt(&initial_user_prompt_for_task, &skill_id_for_task),
            initial_user_message: initial_user_prompt_for_task.clone(),
            tools,
            max_iterations: 16,
        };

        // Bridge AgentEvent → PlannerEvent
        // Also mirror the events into trace.jsonl so the HUB can
        // tail the run via trace_tail() (or via plan_state.json
        // for plan-only events).
        let events_tx_bridge = events_tx_for_task.clone();
        let run_id_trace = run_id_for_task.clone();
        let store_root_trace = store_root_for_task.clone();
        let emit_bridge = move |event: AgentEvent| {
            // Trace to disk for tailing
            if let Ok(store) = RunStore::open_at(store_root_trace.clone()) {
                let trace_event = match &event {
                    AgentEvent::TextDelta(d) => Some(crate::agent::normalized::NormalizedEvent::TextDelta { delta: d.clone() }),
                    AgentEvent::ToolCallStarted { name, arguments } => Some(crate::agent::normalized::NormalizedEvent::ToolUseStart {
                        call_id: uuid::Uuid::new_v4().to_string(),
                        tool: name.clone(),
                        input: arguments.clone(),
                    }),
                    AgentEvent::ToolCallFinished { name, result, is_error } => Some(crate::agent::normalized::NormalizedEvent::ToolUseResult {
                        call_id: uuid::Uuid::new_v4().to_string(),
                        output: serde_json::json!({ "tool": name, "result": result, "is_error": is_error }),
                        is_error: *is_error,
                    }),
                    _ => None,
                };
                if let Some(ev) = trace_event {
                    let _ = store.append_trace(&run_id_trace, &ev);
                }
            }
            match event {
                AgentEvent::TextDelta(d) => {
                    let _ = events_tx_bridge.send(PlannerEvent::TextDelta(d));
                }
                AgentEvent::ToolCallStarted { name, arguments } => {
                    let _ = events_tx_bridge.send(PlannerEvent::ToolCallStarted { name, arguments });
                }
                AgentEvent::ToolCallFinished { name, result, is_error } => {
                    let _ = events_tx_bridge.send(PlannerEvent::ToolCallFinished {
                        name,
                        result,
                        is_error,
                    });
                }
                AgentEvent::PlanReady(plan) => {
                    let _ = events_tx_bridge.send(PlannerEvent::PlanReady(plan));
                }
                AgentEvent::Done => {}
            }
        };

        let result = run_tool_loop(cfg, cancel_for_task.clone(), Box::new(emit_bridge)).await;

        // Persist final plan if any
        match result {
            Ok(r) if r.plan.is_some() => {
                let raw_plan = r.plan.clone().unwrap();
                match commit_finished_plan_in_root(
                    &store_root_for_task,
                    &run_id_for_task,
                    Some(skill_id_for_task.clone()),
                    raw_plan,
                ) {
                    Ok(document) => {
                        let plan_value =
                            serde_json::to_value(&document).unwrap_or(serde_json::Value::Null);
                        {
                            let mut g = state_for_task.lock().await;
                            g.plan = Some(plan_value.clone());
                            g.status = PlanStatus::PlanReady;
                            g.error = None;
                            g.last_event_ms = now_ms();
                            persist_state_in_root(&store_root_for_task, &run_id_for_task, &*g);
                        }
                        let _ = events_tx_for_task.send(PlannerEvent::PlanReady(plan_value));
                        let _ = events_tx_for_task.send(PlannerEvent::Done {
                            status: PlanStatus::PlanReady,
                            error: None,
                        });
                    }
                    Err(e) => {
                        update_run_result_in_root(
                            &store_root_for_task,
                            &run_id_for_task,
                            RunStatus::Error,
                            Some(e.clone()),
                        );
                        {
                            let mut g = state_for_task.lock().await;
                            g.status = PlanStatus::Failed;
                            g.error = Some(e.clone());
                            g.last_event_ms = now_ms();
                            persist_state_in_root(&store_root_for_task, &run_id_for_task, &*g);
                        }
                        let _ = events_tx_for_task.send(PlannerEvent::Done {
                            status: PlanStatus::Failed,
                            error: Some(e),
                        });
                    }
                }
            }
            Ok(_) => {
                let cancelled = cancel_for_task.is_canceled();
                let status = if cancelled {
                    PlanStatus::Cancelled
                } else {
                    PlanStatus::Failed
                };
                let error = if !cancelled {
                    Some("LLM ended without finish_plan".into())
                } else {
                    None
                };
                update_run_result_in_root(
                    &store_root_for_task,
                    &run_id_for_task,
                    if cancelled {
                        RunStatus::Aborted
                    } else {
                        RunStatus::Error
                    },
                    error.clone(),
                );
                {
                    let mut g = state_for_task.lock().await;
                    g.status = status.clone();
                    g.error = error.clone();
                    g.last_event_ms = now_ms();
                    persist_state_in_root(&store_root_for_task, &run_id_for_task, &*g);
                }
                let _ = events_tx_for_task.send(PlannerEvent::Done {
                    status,
                    error,
                });
            }
            Err(e) => {
                update_run_result_in_root(
                    &store_root_for_task,
                    &run_id_for_task,
                    RunStatus::Error,
                    Some(e.clone()),
                );
                {
                    let mut g = state_for_task.lock().await;
                    g.status = PlanStatus::Failed;
                    g.error = Some(e.clone());
                    g.last_event_ms = now_ms();
                    persist_state_in_root(&store_root_for_task, &run_id_for_task, &*g);
                }
                let _ = events_tx_for_task.send(PlannerEvent::Done {
                    status: PlanStatus::Failed,
                    error: Some(e),
                });
            }
            }
            unregister(&run_id_for_task);
        });
    })
    .map_err(|e| format!("Failed to spawn plan-agent thread: {e}"))?;

    Ok(agent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::result::{RunResult, RunStatus, UsageSummary};
    use crate::orchestrator::spec::{AssignmentMode, TaskKind, TaskSpec};
    use crate::orchestrator::RunStore;
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::time::Duration;

    fn unique_root(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "jishu_planner_service_{label}_{}_{}",
            std::process::id(),
            id
        ));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    fn plan_spec() -> TaskSpec {
        TaskSpec {
            task_id: "ts_planner_service_commit".into(),
            kind: TaskKind::Plan,
            message: "Create an executable plan".into(),
            project_path: Some("/project".into()),
            roles: Vec::new(),
            assignment_mode: AssignmentMode::Manual,
            policy: "default".into(),
            parent_run_id: None,
            epic_id: None,
            depth: 0,
            deadline_ms: None,
            labels: HashMap::new(),
            created_at: 1,
        }
    }

    #[test]
    fn commit_finished_plan_writes_typed_plan_document_and_complete_result() {
        let root = unique_root("commit");
        let store = RunStore::open_at(root.clone()).unwrap();
        let spec = plan_spec();
        store.create_run("r_commit", &spec).unwrap();
        store
            .write_result(
                "r_commit",
                &RunResult {
                    run_id: "r_commit".into(),
                    task_id: spec.task_id.clone(),
                    status: RunStatus::Running,
                    started_at: 1,
                    finished_at: None,
                    steps: Vec::new(),
                    usage: UsageSummary::zero(),
                    error: None,
                    cost_usd: None,
                    summary: None,
                },
            )
            .unwrap();

        let document = commit_finished_plan_in_root(
            &root,
            "r_commit",
            Some("jishu-task-planner".into()),
            json!({
                "plan": [
                    {
                        "step_id": "sp_0",
                        "type": "dispatch",
                        "role_id": "default",
                        "prompt": "Turn the user request into implementation steps",
                        "depends_on": []
                    }
                ]
            }),
        )
        .expect("finished plan should commit");

        let plan = store.read_plan("r_commit").unwrap();
        let stored_document = store
            .read_plan_document("r_commit")
            .unwrap()
            .expect("plan_document.json should exist");
        let result = store.read_result("r_commit").unwrap();

        assert_eq!(document.revision, 1);
        assert_eq!(plan.len(), 1);
        assert_eq!(stored_document.steps.len(), 1);
        assert_eq!(result.status, RunStatus::Complete);
        assert!(result.finished_at.is_some());
        assert_eq!(result.error, None);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Regression test: JishuPlannerService::start() must work when called from a
    /// sync context with no tokio runtime entered. This is the path
    /// exercised by Tauri sync commands.
    ///
    /// Before the fix, start() would internally call
    /// `tokio::runtime::Handle::try_current()` which returns
    /// "No tokio runtime: there is no reactor running, must be called
    /// from the context of a Tokio 1.x runtime" when invoked from
    /// a Tauri sync command thread.
    #[test]
    fn start_works_from_sync_context_without_tokio_runtime() {
        // We're on a regular test thread with no tokio runtime entered.
        // If start() tries `tokio::runtime::Handle::try_current()` it
        // will fail. The fix uses a dedicated thread + own runtime.

        let run_id = format!("test_run_{}", now_ms());
        let result = start(
            run_id.clone(),
            "jishu-task-planner".to_string(),
            "Test task".to_string(),
        );

        let agent = result.expect("start() must succeed from sync context");
        assert_eq!(snapshot_state(&agent.state).run_id, run_id);

        // The agent must be registered in the global registry.
        assert!(get(&run_id).is_some(), "agent must be registered");

        // The state must be a valid initial state (Pending or further).
        let state = snapshot_state(&agent.state);
        assert!(matches!(
            state.status,
            PlanStatus::Pending | PlanStatus::Generating | PlanStatus::Failed
        ));

        // Give the background thread a moment to start (or fail fast
        // because no LLM key in test env), then cancel + clean up.
        std::thread::sleep(Duration::from_millis(200));
        cancel_agent(&run_id);
        unregister(&run_id);
    }

    /// start() must work even if called multiple times in a row
    /// (regression: each call must not pollute another agent's state).
    #[test]
    fn start_works_multiple_times_in_a_row() {
        let run_id_a = format!("test_run_a_{}", now_ms());
        let run_id_b = format!("test_run_b_{}", now_ms());

        let agent_a = start(run_id_a.clone(), "skill-a".into(), "task a".into())
            .expect("first start() must succeed");
        let agent_b = start(run_id_b.clone(), "skill-b".into(), "task b".into())
            .expect("second start() must succeed");

        assert_eq!(
            snapshot_state(&agent_a.state).skill_id,
            Some("skill-a".into())
        );
        assert_eq!(
            snapshot_state(&agent_b.state).skill_id,
            Some("skill-b".into())
        );

        // Each must be in its own registry entry.
        assert!(get(&run_id_a).is_some());
        assert!(get(&run_id_b).is_some());

        cancel_agent(&run_id_a);
        cancel_agent(&run_id_b);
        unregister(&run_id_a);
        unregister(&run_id_b);
    }
}
