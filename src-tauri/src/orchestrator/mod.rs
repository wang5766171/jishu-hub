pub mod daemon;
pub mod dispatcher;
pub mod planner;
pub mod proposal;
pub mod rework;
pub mod result;
pub mod spec;
pub mod store;
pub mod trace;

use crate::agent::normalized::{NormalizedEvent, TaskStepKind};
use crate::agent::AgentRegistry;
use dispatcher::{DefaultDispatcher, DispatchContext, Dispatcher};
use planner::PlanContext;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

// Public re-exports for consumers (lib.rs, daemon, CLI)
pub use proposal::EvolutionProposal;
pub use rework::ReworkItem;
pub use result::{RunResult, RunStatus, StepOutcome, StepStatus, UsageSummary};
pub use spec::{AssignmentMode, Step, StepKind, TaskKind, TaskSpec, VerifyCheck};
pub use store::RunStore;
pub use trace::TraceRecorder;

// ── Public API types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSubmitResult {
    pub task_id: String,
    pub run_id: String,
    pub status: RunStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub run_id: String,
    pub spec: TaskSpec,
    pub plan: Vec<Step>,
    pub result: RunResult,
    #[serde(default)]
    pub timeline: Vec<TaskTimelineEvent>,
    #[serde(default)]
    pub rework_routes: Vec<RoleContractRoute>,
    #[serde(default)]
    pub rework_items: Vec<ReworkItem>,
    #[serde(default)]
    pub children: Vec<RunSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSummary {
    pub run_id: String,
    pub task_id: String,
    pub status: RunStatus,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleContractRoute {
    pub from_role_id: String,
    pub from_role_name: String,
    pub from_agent_id: String,
    pub target_role_id: String,
    pub target_role_name: String,
    pub target_agent_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskTimelineEvent {
    pub event_id: String,
    pub kind: String,
    pub title: String,
    pub detail: Option<serde_json::Value>,
    pub step_id: Option<String>,
    pub role_id: Option<String>,
    pub agent_id: Option<String>,
    pub at: Option<i64>,
}

// ── Public functions ──────────────────────────────────────────────────────

/// Submit a task and execute it synchronously (used by Tauri IPC and daemon).
/// In v0.7+ this will be async with SupervisorWorker; for v0.6 it remains
/// synchronous but uses the new data model.
pub fn submit_task(spec: TaskSpec) -> Result<TaskSubmitResult, String> {
    let root = default_runs_root();
    submit_task_in_root(spec, &root)
}

pub fn list_runs() -> Result<Vec<RunSummary>, String> {
    let store = RunStore::open()?;
    let runs = store.list_runs()?;
    // Convert store::RunSummary to our RunSummary (same struct, different module)
    Ok(runs
        .into_iter()
        .map(|r| RunSummary {
            run_id: r.run_id,
            task_id: r.task_id,
            status: r.status,
            started_at: r.started_at,
            finished_at: r.finished_at,
            title: r.title,
        })
        .collect())
}

pub fn get_run(run_id: &str) -> Result<RunRecord, String> {
    let root = default_runs_root();
    get_run_in_root(&root, run_id)
}

pub fn cancel_run(run_id: &str) -> Result<RunResult, String> {
    let root = default_runs_root();
    cancel_run_in_root(&root, run_id)
}

pub fn submit_task_in_root(mut spec: TaskSpec, root: &Path) -> Result<TaskSubmitResult, String> {
    let store = RunStore::open_at(root.to_path_buf())?;
    let started_at = now_ms();

    if spec.task_id.trim().is_empty() {
        spec.task_id = format!("ts_{started_at}");
    }
    let run_id = format!("r_{}_{}", started_at, sanitize_id(&spec.task_id));

    // Create run directory + write spec
    store.create_run(&run_id, &spec)?;

    // Generate plan
    let registry = Arc::new(AgentRegistry::new());
    let plan_ctx = PlanContext {
        registry: registry.clone(),
        previous_active_agent: None,
    };
    let planner = planner::create_planner(&spec.policy);
    let steps = planner.plan(&spec, &plan_ctx).map_err(|e| e.to_string())?;
    store.write_plan(&run_id, &steps)?;

    // Trace plan generation
    let rework_routes = derive_rework_routes(&spec);
    let trace = TraceRecorder::create_in_root(root, &run_id)?;
    trace.append_event(&NormalizedEvent::TaskStep {
        run_id: run_id.clone(),
        step_id: "sp_plan".to_string(),
        kind: TaskStepKind::Plan,
        title: "Plan generated".to_string(),
        detail: Some(serde_json::json!({
            "roles": spec.roles.len(),
            "steps": steps.len(),
            "rework_routes": rework_routes.len(),
        })),
    })?;

    // Execute
    let (status, outcomes, error) = if matches!(spec.kind, spec::TaskKind::Plan) {
        // Plan mode: generate plan via LLM if available, otherwise use planner output
        let llm_steps = generate_plan_with_llm(&spec, &steps);
        let (final_steps, source) = match llm_steps {
            Some(refined) => (refined, "llm"),
            None => (steps.clone(), "template"),
        };
        store.write_plan(&run_id, &final_steps)?;
        trace.append_event(&NormalizedEvent::TaskStep {
            run_id: run_id.clone(),
            step_id: "sp_plan_refined".to_string(),
            kind: TaskStepKind::Plan,
            title: format!("Plan generated ({source})"),
            detail: Some(serde_json::json!({
                "steps": final_steps.len(),
                "source": source,
            })),
        })?;
        (RunStatus::Complete, Vec::new(), None)
    } else {
        execute_steps(&spec, &run_id, &steps, registry, &trace)
    };
    let steps_for_summary = steps.clone();

    let result = RunResult {
        run_id: run_id.clone(),
        task_id: spec.task_id.clone(),
        status: status.clone(),
        started_at,
        finished_at: Some(now_ms()),
        steps: outcomes,
        usage: UsageSummary::default(),
        error,
        cost_usd: None,
        summary: None,
    };
    store.write_result(&run_id, &result)?;

    // Generate LLM summary for terminal runs (best-effort, non-blocking on failure)
    if matches!(
        status,
        RunStatus::Complete | RunStatus::Aborted | RunStatus::Error
    ) {
        if let Ok(summary) = generate_run_summary(&spec, &result, &steps_for_summary) {
            if let Ok(mut r) = store.read_result(&run_id) {
                r.summary = Some(summary);
                let _ = store.write_result(&run_id, &r);
            }
        }
    }

    Ok(TaskSubmitResult {
        task_id: spec.task_id,
        run_id,
        status,
    })
}

pub fn list_runs_in_root(root: &Path) -> Result<Vec<RunSummary>, String> {
    let store = RunStore::open_at(root.to_path_buf())?;
    Ok(store
        .list_runs()?
        .into_iter()
        .map(|r| RunSummary {
            run_id: r.run_id,
            task_id: r.task_id,
            status: r.status,
            started_at: r.started_at,
            finished_at: r.finished_at,
            title: r.title,
        })
        .collect())
}

pub fn get_run_in_root(root: &Path, run_id: &str) -> Result<RunRecord, String> {
    let store = RunStore::open_at(root.to_path_buf())?;
    let spec = store.read_spec(run_id)?;
    let plan = store.read_plan(run_id)?;
    let result = store.read_result(run_id)?;
    let trace_events = store.read_trace(run_id)?;
    let rework_routes = derive_rework_routes(&spec);
    let rework_items = store.read_rework(run_id).unwrap_or_default();

    // Find child runs (runs with parent_run_id == this run_id)
    let children = store
        .list_runs_with_parent(run_id)?
        .into_iter()
        .map(|c| RunSummary {
            run_id: c.run_id,
            task_id: c.task_id,
            status: c.status,
            started_at: c.started_at,
            finished_at: c.finished_at,
            title: c.title,
        })
        .collect();

    let timeline = build_timeline(&spec, &plan, &result, &trace_events, &rework_routes);

    Ok(RunRecord {
        run_id: run_id.to_string(),
        spec,
        plan,
        result,
        timeline,
        rework_routes,
        rework_items,
        children,
    })
}

pub fn cancel_run_in_root(root: &Path, run_id: &str) -> Result<RunResult, String> {
    let store = RunStore::open_at(root.to_path_buf())?;
    let mut result = store.read_result(run_id)?;
    result.status = RunStatus::Aborted;
    result.finished_at = Some(now_ms());
    result.error = Some("Cancelled by user".to_string());
    store.write_result(run_id, &result)?;
    Ok(result)
}

/// Execute an existing plan that was generated by Plan mode.
/// Spawns a background tokio task; returns the current state immediately.
/// UI can poll `run_get` to track progress.
pub fn execute_plan(run_id: &str) -> Result<RunResult, String> {
    let root = default_runs_root();
    execute_plan_in_root(&root, run_id)
}

pub fn execute_plan_in_root(root: &Path, run_id: &str) -> Result<RunResult, String> {
    let store = RunStore::open_at(root.to_path_buf())?;
    let spec = store.read_spec(run_id)?;
    let plan = store.read_plan(run_id)?;
    let mut result = store.read_result(run_id)?;

    // Only allow executing plans that are currently in Complete (Plan mode output)
    // or already running (re-attach after restart)
    if !matches!(result.status, RunStatus::Complete | RunStatus::Running) {
        return Err(format!(
            "Cannot execute plan: run {} is in {:?} status",
            run_id, result.status
        ));
    }

    // Mark as running BEFORE spawning — UI sees the transition immediately
    result.status = RunStatus::Running;
    result.started_at = now_ms();
    result.finished_at = None;
    result.steps.clear();
    result.error = None;
    store.write_result(run_id, &result)?;

    // Spawn background task — non-blocking
    let root_owned = root.to_path_buf();
    let run_id_owned = run_id.to_string();
    std::thread::spawn(move || {
        let _ = execute_plan_blocking(&root_owned, &run_id_owned);
    });

    Ok(result)
}

/// Blocking version of plan execution. Runs in background thread.
fn execute_plan_blocking(root: &Path, run_id: &str) -> Result<(), String> {
    let store = RunStore::open_at(root.to_path_buf())?;
    let spec = store.read_spec(run_id)?;
    let plan = store.read_plan(run_id)?;

    let trace = TraceRecorder::create_in_root(root, run_id)?;
    trace.append_event(&NormalizedEvent::TaskStep {
        run_id: run_id.to_string(),
        step_id: "sp_execute".to_string(),
        kind: TaskStepKind::Dispatch,
        title: "Plan execution started".to_string(),
        detail: Some(serde_json::json!({
            "steps": plan.len(),
        })),
    })?;

    let registry = Arc::new(AgentRegistry::new());
    let (status, outcomes, error) = execute_steps(&spec, run_id, &plan, registry, &trace);

    let mut result = store.read_result(run_id)?;
    result.status = status.clone();
    result.finished_at = Some(now_ms());
    result.steps = outcomes;
    result.error = error;
    store.write_result(run_id, &result)?;

    trace.append_event(&NormalizedEvent::TaskStep {
        run_id: run_id.to_string(),
        step_id: "sp_execute_done".to_string(),
        kind: if status == RunStatus::Complete {
            TaskStepKind::Done
        } else {
            TaskStepKind::Failed
        },
        title: format!("Plan execution finished: {:?}", status),
        detail: None,
    })?;

    // LLM summary in user's language (best-effort, 8s timeout)
    if matches!(status, RunStatus::Complete | RunStatus::Error) {
        if let Ok(summary) = generate_run_summary(&spec, &result, &plan) {
            if let Ok(mut r) = store.read_result(run_id) {
                r.summary = Some(summary);
                let _ = store.write_result(run_id, &r);
            }
        }
    }

    Ok(())
}

// ── Internal helpers ──────────────────────────────────────────────────────

/// Use the configured LLM to refine a plan based on the task spec.
/// Returns refined steps, or None if LLM is unavailable / fails.
fn generate_plan_with_llm(spec: &TaskSpec, template_steps: &[Step]) -> Option<Vec<Step>> {
    let store = crate::llm::config::ModelStore::load().ok()?;
    let preset = store.get_active()?.clone();
    let provider = crate::llm::create_provider(&preset).ok()?;

    let roles_desc = if spec.roles.is_empty() {
        "No specific roles assigned — single agent execution.".to_string()
    } else {
        spec.roles
            .iter()
            .map(|r| {
                format!(
                    "- {} ({}): agent={}, edit={}, cmd={}, rework={}",
                    r.role_name,
                    r.role_id,
                    r.agent_id.as_deref().unwrap_or("auto"),
                    r.can_edit_files,
                    r.can_run_commands,
                    r.can_receive_rework,
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let template_desc = template_steps
        .iter()
        .map(|s| {
            let kind_desc = match &s.kind {
                StepKind::Dispatch { role_id, prompt, .. } => {
                    // Truncate at char boundary to handle multi-byte UTF-8
                    let truncated: String = prompt.chars().take(100).collect();
                    format!("Dispatch to role '{}' with prompt: {}", role_id, truncated)
                }
                StepKind::Reflect { question } => format!("Reflect: {}", question),
                _ => format!("{:?}", s.kind),
            };
            format!("Step {}: {}", s.step_id, kind_desc)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let system_prompt = r#"You are a task execution planner. Given a task description, assigned roles, and a template plan, generate a refined execution plan.

Return ONLY a JSON array of step objects. Each object must have:
- step_id: "sp_0", "sp_1", etc.
- type: "dispatch" (for agent steps) or "reflect" (for review/reflection steps)
- role_id: must match one of the assigned roles
- prompt: detailed instruction for the agent in Chinese
- project: the project path

Rules:
- First step should analyze the task and clarify scope
- Middle steps should execute the actual work in role order
- Last step should be a Reflect step for the supervisor to review outcomes
- Make prompts specific and actionable, not generic
- Return ONLY the JSON array, no markdown fences"#;

    let user_prompt = format!(
        "Task: {}\nProject: {}\n\nAssigned roles:\n{}\n\nTemplate plan:\n{}",
        spec.message,
        spec.project_path.as_deref().unwrap_or("."),
        roles_desc,
        template_desc,
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
        max_tokens: Some(8192),
        temperature: Some(0.3),
    };

    let cancel = crate::llm::CancelToken::new();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;

    let text = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let text_clone = text.clone();
    let cancel_for_async = cancel.clone();
    let result = rt.block_on(async {
        use tokio::time::{timeout, Duration};
        let inner = async {
            provider
                .stream_chat(
                    req,
                    Box::new(move |event| {
                        if let NormalizedEvent::TextDelta { delta } = event {
                            if let Ok(mut t) = text_clone.lock() {
                                t.push_str(&delta);
                            }
                        }
                    }),
                    &cancel_for_async,
                )
                .await
        };
        // 5s timeout — fall back to template on slow/failed LLM
        match timeout(Duration::from_secs(5), inner).await {
            Ok(r) => r,
            Err(_) => {
                cancel.cancel();
                Err(crate::llm::LlmError::Request("LLM timed out (15s)".into()))
            }
        }
    });

    if result.is_err() {
        return None;
    }
    let response_text = text.lock().ok().map(|t| t.clone())?;

    // Parse the JSON response
    let json_str = response_text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let raw_steps: Vec<RawLlmStep> = match serde_json::from_str(json_str) {
        Ok(s) => s,
        Err(_) => return None,
    };

    let project = spec.project_path.clone().unwrap_or_else(|| ".".to_string());

    Some(
        raw_steps
            .into_iter()
            .enumerate()
            .filter_map(|(i, raw)| {
                let step_id = if raw.step_id.is_empty() {
                    format!("sp_{i}")
                } else {
                    raw.step_id.clone()
                };

                let kind = match raw.r#type.as_str() {
                    "dispatch" => {
                        let role_id = if raw.role_id.is_empty() {
                            spec.roles.first()?.role_id.clone()
                        } else {
                            raw.role_id.clone()
                        };
                        StepKind::Dispatch {
                            role_id,
                            prompt: raw.prompt.clone(),
                            project: project.clone(),
                            session: None,
                        }
                    }
                    "reflect" => StepKind::Reflect {
                        question: raw.prompt.clone(),
                    },
                    _ => return None,
                };

                Some(Step {
                    step_id,
                    kind,
                    depends_on: if i > 0 { vec![format!("sp_{}", i - 1)] } else { vec![] },
                    timeout_ms: spec.deadline_ms,
                })
            })
            .collect(),
    )
}

#[derive(Deserialize)]
struct RawLlmStep {
    #[serde(default)]
    step_id: String,
    #[serde(rename = "type", default)]
    r#type: String,
    #[serde(default)]
    role_id: String,
    #[serde(default)]
    prompt: String,
}

/// Detect UI language from i18n config. Defaults to "zh" (most common in this project).
fn detect_ui_language() -> &'static str {
    if let Ok(content) = std::fs::read_to_string(format!(
        "{}/.jishu-hub/state.json",
        dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    )) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(lang) = value.get("language").and_then(|v| v.as_str()) {
                if lang.starts_with("en") {
                    return "en";
                }
            }
        }
    }
    "zh"
}

/// Use LLM to generate a human-readable summary of a completed run.
/// Returns the summary string, or empty string on failure.
fn generate_run_summary(
    spec: &TaskSpec,
    result: &RunResult,
    steps: &[Step],
) -> Result<String, String> {
    generate_run_summary_with_lang(spec, result, steps, detect_ui_language())
}

/// Use LLM to generate a human-readable summary in the user's UI language.
fn generate_run_summary_with_lang(
    spec: &TaskSpec,
    result: &RunResult,
    steps: &[Step],
    language: &str,
) -> Result<String, String> {
    let store = crate::llm::config::ModelStore::load()?;
    let preset = store
        .get_active()
        .ok_or_else(|| "No active model".to_string())?
        .clone();
    let provider = crate::llm::create_provider(&preset)?;

    let status_label = match result.status {
        RunStatus::Complete => "已完成",
        RunStatus::Aborted => "已取消",
        RunStatus::Error => "失败",
        RunStatus::Running => "运行中",
        RunStatus::Queued => "排队中",
        RunStatus::AwaitingRework => "等待返工",
        RunStatus::AwaitingApproval => "等待审批",
    };

    let step_descs: Vec<String> = steps
        .iter()
        .take(20)
        .enumerate()
        .map(|(i, s)| {
            let kind_str = match &s.kind {
                StepKind::Dispatch { role_id, prompt, .. } => {
                    format!("派发给 [{}]：{}", role_id, prompt.chars().take(60).collect::<String>())
                }
                StepKind::Reflect { question } => {
                    format!("反思：{}", question.chars().take(60).collect::<String>())
                }
                StepKind::Shell { command, .. } => format!("执行命令：{}", command),
                StepKind::Read { path, .. } => format!("读取：{}", path.display()),
                StepKind::Write { path, requires_approval, .. } => {
                    format!("写入：{}{}", path.display(), if *requires_approval { "（需审批）" } else { "" })
                }
                StepKind::Verify { check } => format!("验证：{:?}", check),
            };
            format!("{}. {}", i + 1, kind_str)
        })
        .collect();

    let role_count = spec.roles.len();
    let step_count = steps.len();
    let error_info = result
        .error
        .as_deref()
        .map(|e| format!("\n错误信息：{}", e.chars().take(200).collect::<String>()))
        .unwrap_or_default();

    let system_prompt = "你是 jishu agent 任务总结助手。请根据任务信息生成一段简洁、易读的中文运行总结（150 字以内）。要求：\n- 用 1-3 句话概述任务目标和结果\n- 提及实际执行的步骤数量和涉及的角色\n- 如有错误或重要产出，请说明\n- 不要重复机械日志（不要写 'plan generated' 这种），要说人话\n- 用 markdown 不需要，输出纯文本";

    let user_prompt = format!(
        "任务目标：{}\n任务状态：{}\n项目路径：{}\n涉及角色：{} 个\n执行步骤：{} 个\n\n步骤内容：\n{}{}",
        spec.message,
        status_label,
        spec.project_path.as_deref().unwrap_or("（未指定）"),
        role_count,
        step_count,
        step_descs.join("\n"),
        error_info,
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
        max_tokens: Some(500),
        temperature: Some(0.5),
    };

    let cancel = crate::llm::CancelToken::new();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("Runtime: {e}"))?;

    let text = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let text_clone = text.clone();
    let cancel_for_async = cancel.clone();
    let result_call = rt.block_on(async {
        use tokio::time::{timeout, Duration};
        let inner = provider.stream_chat(
            req,
            Box::new(move |event| {
                if let NormalizedEvent::TextDelta { delta } = event {
                    if let Ok(mut t) = text_clone.lock() {
                        t.push_str(&delta);
                    }
                }
            }),
            &cancel_for_async,
        );
        // 8s timeout — summary is best-effort
        match timeout(Duration::from_secs(8), inner).await {
            Ok(r) => r,
            Err(_) => {
                cancel.cancel();
                Err(crate::llm::LlmError::Request("LLM timed out (8s)".into()))
            }
        }
    });

    result_call.map_err(|e| format!("LLM summary failed: {e}"))?;
    let summary = text.lock().map_err(|e| e.to_string())?.clone();
    if summary.trim().is_empty() {
        return Err("Empty summary from LLM".into());
    }
    Ok(summary.trim().to_string())
}

/// Delete a run directory entirely. Returns Ok(()) if removed.
pub fn delete_run(run_id: &str) -> Result<(), String> {
    let root = default_runs_root();
    delete_run_in_root(&root, run_id)
}

pub fn delete_run_in_root(root: &Path, run_id: &str) -> Result<(), String> {
    let run_dir = root.join(run_id);
    if !run_dir.exists() {
        return Err(format!("Run not found: {run_id}"));
    }
    std::fs::remove_dir_all(&run_dir).map_err(|e| e.to_string())
}

/// Regenerate the LLM summary for a run, optionally in a specific language.
pub fn regenerate_summary(run_id: &str, language: Option<&str>) -> Result<(), String> {
    let root = default_runs_root();
    let store = RunStore::open_at(root.clone())?;
    let spec = store.read_spec(run_id)?;
    let plan = store.read_plan(run_id)?;
    let result = store.read_result(run_id)?;
    let lang = language.unwrap_or_else(|| detect_ui_language());
    match generate_run_summary_with_lang(&spec, &result, &plan, lang) {
        Ok(summary) => {
            let mut r = result;
            r.summary = Some(summary);
            store.write_result(run_id, &r)?;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn execute_steps(
    spec: &TaskSpec,
    run_id: &str,
    steps: &[Step],
    registry: Arc<AgentRegistry>,
    trace: &TraceRecorder,
) -> (RunStatus, Vec<StepOutcome>, Option<String>) {
    let dispatcher = DefaultDispatcher::new();
    let mut outcomes = Vec::new();
    let mut first_error = None;

    for step in steps {
        let step_started = now_ms();
        let _ = trace.append_event(&NormalizedEvent::TaskStep {
            run_id: run_id.to_string(),
            step_id: step.step_id.clone(),
            kind: TaskStepKind::Dispatch,
            title: format!("Executing {}", step.step_id),
            detail: None,
        });
        let mut emitter = |event: &NormalizedEvent| {
            let _ = trace.append_event(event);
        };
        let mut ctx = DispatchContext {
            registry: registry.clone(),
            run_id,
            spec,
            trace,
            emitter: &mut emitter,
        };
        match dispatcher.execute(step, &mut ctx) {
            Ok(outcome) => {
                let failed = outcome.status == StepStatus::Failed;
                outcomes.push(outcome);
                let _ = trace.append_event(&NormalizedEvent::TaskStep {
                    run_id: run_id.to_string(),
                    step_id: step.step_id.clone(),
                    kind: if failed {
                        TaskStepKind::Failed
                    } else {
                        TaskStepKind::Done
                    },
                    title: if failed {
                        format!("{} failed", step.step_id)
                    } else {
                        format!("{} complete", step.step_id)
                    },
                    detail: None,
                });
                if failed && first_error.is_none() {
                    first_error = Some(format!("{} failed", step.step_id));
                }
            }
            Err(err) => {
                let message = err.to_string();
                let step_finished = now_ms();
                outcomes.push(StepOutcome {
                    step_id: step.step_id.clone(),
                    role_id: String::new(),
                    agent_id: "unknown".to_string(),
                    status: StepStatus::Failed,
                    output: Some(serde_json::json!({ "error": message })),
                    started_at: step_started,
                    finished_at: step_finished,
                    usage: UsageSummary::zero(),
                });
                let _ = trace.append_event(&NormalizedEvent::TaskStep {
                    run_id: run_id.to_string(),
                    step_id: step.step_id.clone(),
                    kind: TaskStepKind::Failed,
                    title: format!("{} failed: {err}", step.step_id),
                    detail: None,
                });
                first_error.get_or_insert_with(|| err.to_string());
                break;
            }
        }
    }

    if let Some(error) = first_error {
        (RunStatus::Error, outcomes, Some(error))
    } else {
        (RunStatus::Complete, outcomes, None)
    }
}

fn build_timeline(
    spec: &TaskSpec,
    plan: &[Step],
    result: &RunResult,
    trace_events: &[NormalizedEvent],
    rework_routes: &[RoleContractRoute],
) -> Vec<TaskTimelineEvent> {
    let mut timeline = Vec::new();
    timeline.push(TaskTimelineEvent {
        event_id: "task_created".to_string(),
        kind: "task_created".to_string(),
        title: "Task submitted from HUB".to_string(),
        detail: Some(serde_json::json!({
            "task_id": &spec.task_id,
            "message": &spec.message,
            "roles": spec.roles.len(),
        })),
        step_id: None,
        role_id: None,
        agent_id: None,
        at: Some(spec.created_at),
    });

    for (idx, role) in spec.roles.iter().enumerate() {
        timeline.push(TaskTimelineEvent {
            event_id: format!("role_assigned_{idx}"),
            kind: "role_assigned".to_string(),
            title: format!(
                "{} assigned to {}",
                role.role_name,
                role.agent_id.as_deref().unwrap_or("(auto)")
            ),
            detail: Some(serde_json::json!({
                "responsibilities": &role.responsibilities,
                "acceptance": &role.acceptance,
                "can_receive_rework": role.can_receive_rework,
            })),
            step_id: Some(format!("sp_{idx}")),
            role_id: Some(role.role_id.clone()),
            agent_id: role.agent_id.clone(),
            at: Some(spec.created_at),
        });
    }

    for route in rework_routes {
        timeline.push(TaskTimelineEvent {
            event_id: format!(
                "rework_route_{}_{}",
                route.from_role_id, route.target_role_id
            ),
            kind: "rework_route".to_string(),
            title: format!(
                "{} findings route to {}",
                route.from_role_name, route.target_role_name
            ),
            detail: Some(serde_json::json!(route)),
            step_id: None,
            role_id: Some(route.from_role_id.clone()),
            agent_id: Some(route.from_agent_id.clone()),
            at: Some(spec.created_at),
        });
    }

    for (idx, step) in plan.iter().enumerate() {
        let (agent_id, role_id) = match &step.kind {
            StepKind::Dispatch { role_id, .. } => {
                let agent = spec
                    .roles
                    .iter()
                    .find(|r| r.role_id == *role_id)
                    .and_then(|r| r.agent_id.clone());
                (agent, Some(role_id.clone()))
            }
            _ => (None, None),
        };
        timeline.push(TaskTimelineEvent {
            event_id: format!("plan_step_{}", step.step_id),
            kind: "plan_step".to_string(),
            title: format!("Plan step {}", step.step_id),
            detail: Some(serde_json::json!(step)),
            step_id: Some(step.step_id.clone()),
            role_id,
            agent_id,
            at: Some(result.started_at),
        });
    }

    for (idx, event) in trace_events.iter().enumerate() {
        if let NormalizedEvent::TaskStep {
            step_id,
            kind,
            title,
            detail,
            ..
        } = event
        {
            timeline.push(TaskTimelineEvent {
                event_id: format!("trace_{idx}"),
                kind: format!("{kind:?}").to_lowercase(),
                title: title.clone(),
                detail: detail.clone(),
                step_id: Some(step_id.clone()),
                role_id: None,
                agent_id: None,
                at: None,
            });
        }
    }

    timeline.push(TaskTimelineEvent {
        event_id: "task_finished".to_string(),
        kind: "task_finished".to_string(),
        title: format!("Task finished with status {:?}", result.status),
        detail: result
            .error
            .as_ref()
            .map(|error| serde_json::json!({ "error": error })),
        step_id: None,
        role_id: None,
        agent_id: None,
        at: result.finished_at,
    });
    timeline
}

fn derive_rework_routes(spec: &TaskSpec) -> Vec<RoleContractRoute> {
    let mut routes = Vec::new();
    for source in &spec.roles {
        let contract = format!(
            "{}\n{}",
            source.responsibilities.join("\n"),
            source.acceptance.join("\n")
        )
        .to_lowercase();
        for target in &spec.roles {
            if source.role_id == target.role_id || !target.can_receive_rework {
                continue;
            }
            let mentioned = contract.contains(&target.role_id.to_lowercase())
                || contract.contains(&target.role_name.to_lowercase())
                || contract.contains(&format!("[{}]", target.role_name.to_lowercase()))
                || contract.contains(&format!("{{[{}]}}", target.role_name.to_lowercase()));
            if mentioned {
                routes.push(RoleContractRoute {
                    from_role_id: source.role_id.clone(),
                    from_role_name: source.role_name.clone(),
                    from_agent_id: source.agent_id.clone().unwrap_or_default(),
                    target_role_id: target.role_id.clone(),
                    target_role_name: target.role_name.clone(),
                    target_agent_id: target.agent_id.clone().unwrap_or_default(),
                    reason: "role contract mentions the target role and the target can receive rework"
                        .to_string(),
                });
            }
        }
    }
    routes
}

fn default_runs_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".jishu-hub")
        .join("runs")
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::spec::RoleAssignment;

    fn unique_root(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir()
            .join(format!("jishu_{label}_{}_{id}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    fn make_spec_with_roles(task_id: &str) -> TaskSpec {
        TaskSpec {
            task_id: task_id.into(),
            kind: spec::TaskKind::Plan,
            message: "Implement the task".into(),
            project_path: Some("D:/project".into()),
            roles: vec![
                RoleAssignment {
                    role_id: "architect".into(),
                    role_name: "架构师".into(),
                    agent_id: Some("claude1".into()),
                    responsibilities: vec!["架构设计".into()],
                    acceptance: vec!["设计完成".into()],
                    can_edit_files: false,
                    can_run_commands: false,
                    can_receive_rework: true,
                },
                RoleAssignment {
                    role_id: "auditor".into(),
                    role_name: "审计员".into(),
                    agent_id: Some("codex".into()),
                    responsibilities: vec!["最终审计".into()],
                    acceptance: vec!["无 P0/P1".into()],
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
            created_at: 1,
            deadline_ms: None,
            labels: HashMap::new(),
        }
    }

    #[test]
    fn hub_plan_task_submit_writes_spec_plan_and_result() {
        let root = unique_root("core_test");
        let _ = std::fs::remove_dir_all(&root);

        let spec = make_spec_with_roles("ts_hub_roles");
        let submitted = submit_task_in_root(spec.clone(), &root).unwrap();
        let run_dir = root.join(&submitted.run_id);

        assert_eq!(submitted.task_id, "ts_hub_roles");
        assert!(run_dir.join("spec.json").exists());
        assert!(run_dir.join("plan.json").exists());
        assert!(run_dir.join("result.json").exists());

        let stored_spec: TaskSpec =
            serde_json::from_str(&std::fs::read_to_string(run_dir.join("spec.json")).unwrap())
                .unwrap();
        assert_eq!(stored_spec.roles.len(), 2);

        let plan: Vec<Step> =
            serde_json::from_str(&std::fs::read_to_string(run_dir.join("plan.json")).unwrap())
                .unwrap();
        assert_eq!(plan.len(), 2);
        // Steps now use role_id, not agent
        assert!(matches!(
            &plan[0].kind,
            StepKind::Dispatch { role_id, .. } if role_id == "architect"
        ));
        assert!(matches!(
            &plan[1].kind,
            StepKind::Dispatch { role_id, .. } if role_id == "auditor"
        ));

        let result: RunResult =
            serde_json::from_str(&std::fs::read_to_string(run_dir.join("result.json")).unwrap())
                .unwrap();
        assert!(matches!(result.status, RunStatus::Complete));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hub_can_list_get_and_cancel_submitted_runs() {
        let root = unique_root("core_query_test");
        let _ = std::fs::remove_dir_all(&root);

        let spec = TaskSpec {
            task_id: "ts_query".into(),
            kind: spec::TaskKind::Plan,
            message: "Track me".into(),
            project_path: Some("D:/project".into()),
            roles: Vec::new(),
            assignment_mode: AssignmentMode::Manual,
            policy: "default".into(),
            parent_run_id: None,
            epic_id: None,
            depth: 0,
            created_at: 1,
            deadline_ms: None,
            labels: HashMap::new(),
        };

        let submitted = submit_task_in_root(spec, &root).unwrap();

        let runs = list_runs_in_root(&root).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, submitted.run_id);
        assert_eq!(runs[0].task_id, "ts_query");

        let record = get_run_in_root(&root, &submitted.run_id).unwrap();
        assert_eq!(record.spec.task_id, "ts_query");
        assert_eq!(record.plan.len(), 1);
        assert!(matches!(record.result.status, RunStatus::Complete));

        let cancelled = cancel_run_in_root(&root, &submitted.run_id).unwrap();
        assert!(matches!(cancelled.status, RunStatus::Aborted));
        let record = get_run_in_root(&root, &submitted.run_id).unwrap();
        assert!(matches!(record.result.status, RunStatus::Aborted));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn role_contract_rework_routes_are_exposed_in_timeline() {
        let root = unique_root("rework_route_test");
        let _ = std::fs::remove_dir_all(&root);

        let spec = TaskSpec {
            task_id: "ts_rework".into(),
            kind: spec::TaskKind::Plan,
            message: "Audit implementation".into(),
            project_path: Some("D:/project".into()),
            roles: vec![
                RoleAssignment {
                    role_id: "developer".into(),
                    role_name: "Developer".into(),
                    agent_id: Some("claude2".into()),
                    responsibilities: vec!["Implement the feature".into()],
                    acceptance: vec!["Feature works".into()],
                    can_edit_files: true,
                    can_run_commands: true,
                    can_receive_rework: true,
                },
                RoleAssignment {
                    role_id: "auditor".into(),
                    role_name: "Auditor".into(),
                    agent_id: Some("codex".into()),
                    responsibilities: vec!["Review [Developer] code quality".into()],
                    acceptance: vec!["Route defects to {[Developer]}".into()],
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
            created_at: 1,
            deadline_ms: None,
            labels: HashMap::new(),
        };

        let submitted = submit_task_in_root(spec, &root).unwrap();
        let record = get_run_in_root(&root, &submitted.run_id).unwrap();

        assert_eq!(record.rework_routes.len(), 1);
        assert_eq!(record.rework_routes[0].from_role_id, "auditor");
        assert_eq!(record.rework_routes[0].target_role_id, "developer");
        assert!(record
            .timeline
            .iter()
            .any(|event| event.kind == "rework_route"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn task_spec_roundtrip() {
        let spec = TaskSpec {
            task_id: "ts_1234_abcd".into(),
            kind: spec::TaskKind::Run,
            message: "Fix the bug".into(),
            project_path: Some("/tmp/proj".into()),
            roles: Vec::new(),
            assignment_mode: AssignmentMode::Manual,
            policy: "default".into(),
            parent_run_id: None,
            epic_id: None,
            depth: 0,
            created_at: 1700000000,
            deadline_ms: None,
            labels: HashMap::new(),
        };
        let json = serde_json::to_string(&spec).unwrap();
        let de: TaskSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(spec.task_id, de.task_id);
    }

    #[test]
    fn step_kind_dispatch_uses_role_id() {
        let step = Step {
            step_id: "sp_0".into(),
            kind: StepKind::Dispatch {
                role_id: "developer".into(),
                prompt: "hello".into(),
                project: "/tmp".into(),
                session: None,
            },
            depends_on: vec![],
            timeout_ms: None,
        };
        let json = serde_json::to_string(&step).unwrap();
        assert!(json.contains("\"type\":\"dispatch\""));
        assert!(json.contains("\"role_id\":\"developer\""));
        let de: Step = serde_json::from_str(&json).unwrap();
        assert_eq!(step.step_id, de.step_id);
    }

    #[test]
    fn evolution_proposal_roundtrip() {
        let p = EvolutionProposal {
            proposal_id: "ep_1234".into(),
            created_at: 1700000000,
            source_task_id: "ts_1234".into(),
            target: "Fix auth".into(),
            kind: proposal::ProposalKind::CodeEdit,
            diff: None,
            rationale: "Security fix".into(),
            risk: proposal::RiskLevel::Low,
            status: proposal::ProposalStatus::Draft,
        };
        let json = serde_json::to_string(&p).unwrap();
        let de: EvolutionProposal = serde_json::from_str(&json).unwrap();
        assert_eq!(p.proposal_id, de.proposal_id);
    }
}
