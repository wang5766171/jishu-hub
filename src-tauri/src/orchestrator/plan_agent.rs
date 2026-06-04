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
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

pub type AsyncToolHandler = Arc<
    dyn Fn(
            serde_json::Value,
        )
            -> Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>>
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
pub enum PlanAgentEvent {
    TextDelta(String),
    ToolCallStarted { name: String, arguments: serde_json::Value },
    ToolCallFinished { name: String, result: String, is_error: bool },
    PlanReady(serde_json::Value),
    Done { status: PlanStatus, error: Option<String> },
}

/// Live PlanAgent for one run. Holds shared state + cancel token +
/// an events channel the HUB subscribes to.
pub struct PlanAgent {
    pub state: Arc<Mutex<PlanState>>,
    pub cancel: CancelToken,
    pub events_tx: mpsc::UnboundedSender<PlanAgentEvent>,
}

/// Global registry of live plan agents, keyed by run_id.
pub type PlanRegistry = Arc<std::sync::Mutex<HashMap<String, Arc<PlanAgent>>>>;

static GLOBAL_PLANS: std::sync::OnceLock<PlanRegistry> = std::sync::OnceLock::new();

pub fn global_plans() -> &'static PlanRegistry {
    GLOBAL_PLANS.get_or_init(|| Arc::new(std::sync::Mutex::new(HashMap::new())))
}

pub fn register(plan: Arc<PlanAgent>) {
    let key = plan.state.clone();
    // The state is a tokio Mutex; use blocking snapshot to extract run_id.
    let key_id = snapshot_state(&key).run_id;
    global_plans().lock().unwrap().insert(key_id, plan);
}

pub fn unregister(run_id: &str) {
    global_plans().lock().unwrap().remove(run_id);
}

pub fn get(run_id: &str) -> Option<Arc<PlanAgent>> {
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
    if let Ok(store) = crate::orchestrator::RunStore::open() {
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
    if let Ok(store) = crate::orchestrator::RunStore::open() {
        if let Ok(val) = serde_json::to_value(state) {
            let _ = store.write_plan_state(run_id, &val);
        }
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
         - First step should be scope/clarification. Last step should be a Reflect.\n\
         - Stream your plan as prose (text_delta events). When the plan structure is complete, call `finish_plan` with the plan JSON array as the argument.\n\
         - The plan JSON must be an array: [{{step_id, type, role_id, prompt, depends_on, project}}].\n\n\
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
                "roles": skill.roles,
            });
            serde_json::to_string_pretty(&manifest)
                .map_err(|e| format!("Serialize: {e}"))
        })
    });

    let finish_plan_handler: AsyncToolHandler = Arc::new(move |args: serde_json::Value| {
        let _args = args;
        Box::pin(async move {
            Ok(serde_json::to_string(&_args).unwrap_or_default())
        })
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
                         JSON (array of step objects) when done drafting."
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
                                "project": { "type": "string" }
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

/// Start a PlanAgent for a run. Spawns background task, returns
/// immediately with a handle.
pub async fn start(
    run_id: String,
    skill_id: String,
    initial_user_prompt: String,
) -> Result<Arc<PlanAgent>, String> {
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
    let (events_tx, _events_rx) = mpsc::unbounded_channel::<PlanAgentEvent>();

    let agent = Arc::new(PlanAgent {
        state: state.clone(),
        cancel: cancel.clone(),
        events_tx: events_tx.clone(),
    });

    {
        let g = state.lock().await;
        persist_state(&run_id, &*g);
    }

    register(agent.clone());

    // Spawn background task
    let state_for_task = state.clone();
    let events_tx_for_task = events_tx.clone();
    let cancel_for_task = cancel.clone();
    let run_id_for_task = run_id.clone();
    let skill_id_for_task = skill_id.clone();
    let initial_user_prompt_for_task = initial_user_prompt.clone();

    tokio::spawn(async move {
        // Update status
        {
            let mut g = state_for_task.lock().await;
            g.status = PlanStatus::Generating;
            g.last_event_ms = now_ms();
        }
        {
            let g = state_for_task.lock().await;
            persist_state(&run_id_for_task, &*g);
        }

        let tools = build_tools(&skill_id_for_task);
        let cfg = AgentLoopConfig {
            system_prompt: system_prompt(&initial_user_prompt_for_task, &skill_id_for_task),
            initial_user_message: initial_user_prompt_for_task.clone(),
            tools,
            max_iterations: 16,
        };

        // Bridge AgentEvent → PlanAgentEvent
        // Also mirror the events into trace.jsonl so the HUB can
        // tail the run via trace_tail() (or via plan_state.json
        // for plan-only events).
        let events_tx_bridge = events_tx_for_task.clone();
        let run_id_trace = run_id_for_task.clone();
        let emit_bridge = move |event: AgentEvent| {
            // Trace to disk for tailing
            if let Ok(store) = crate::orchestrator::RunStore::open() {
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
                    let _ = events_tx_bridge.send(PlanAgentEvent::TextDelta(d));
                }
                AgentEvent::ToolCallStarted { name, arguments } => {
                    let _ = events_tx_bridge.send(PlanAgentEvent::ToolCallStarted { name, arguments });
                }
                AgentEvent::ToolCallFinished { name, result, is_error } => {
                    let _ = events_tx_bridge.send(PlanAgentEvent::ToolCallFinished {
                        name,
                        result,
                        is_error,
                    });
                }
                AgentEvent::PlanReady(plan) => {
                    let _ = events_tx_bridge.send(PlanAgentEvent::PlanReady(plan));
                }
                AgentEvent::Done => {}
            }
        };

        let result = run_tool_loop(cfg, cancel_for_task.clone(), Box::new(emit_bridge)).await;

        // Persist final plan if any
        match result {
            Ok(r) if r.plan.is_some() => {
                let plan = r.plan.clone().unwrap();
                // Write plan.json (raw serde_json::Value, not [Step]).
                // Use std::fs directly to avoid needing a new RunStore method.
                if let Ok(store) = crate::orchestrator::RunStore::open() {
                    let dir = store.root().join(&run_id_for_task);
                    if let Ok(json) = serde_json::to_string_pretty(&plan) {
                        let _ = std::fs::write(dir.join("plan.json"), json);
                    }
                }
                {
                    let mut g = state_for_task.lock().await;
                    g.plan = Some(plan);
                    g.status = PlanStatus::PlanReady;
                    g.last_event_ms = now_ms();
                    persist_state(&run_id_for_task, &*g);
                }
                let _ = events_tx_for_task.send(PlanAgentEvent::Done {
                    status: PlanStatus::PlanReady,
                    error: None,
                });
            }
            Ok(_) => {
                let cancelled = cancel_for_task.is_canceled();
                {
                    let mut g = state_for_task.lock().await;
                    g.status = if cancelled {
                        PlanStatus::Cancelled
                    } else {
                        PlanStatus::Failed
                    };
                    g.error = if !cancelled {
                        Some("LLM ended without finish_plan".into())
                    } else {
                        None
                    };
                    g.last_event_ms = now_ms();
                    persist_state(&run_id_for_task, &*g);
                }
                let _ = events_tx_for_task.send(PlanAgentEvent::Done {
                    status: if cancelled {
                        PlanStatus::Cancelled
                    } else {
                        PlanStatus::Failed
                    },
                    error: if !cancelled {
                        Some("LLM ended without finish_plan".into())
                    } else {
                        None
                    },
                });
            }
            Err(e) => {
                {
                    let mut g = state_for_task.lock().await;
                    g.status = PlanStatus::Failed;
                    g.error = Some(e.clone());
                    g.last_event_ms = now_ms();
                    persist_state(&run_id_for_task, &*g);
                }
                let _ = events_tx_for_task.send(PlanAgentEvent::Done {
                    status: PlanStatus::Failed,
                    error: Some(e),
                });
            }
        }
        unregister(&run_id_for_task);
    });

    Ok(agent)
}
