use super::{DispatchContext, DispatchError, Dispatcher};
use crate::agent::{ChatRequest, NormalizedEvent};
use crate::orchestrator::result::{StepOutcome, StepStatus, UsageSummary};
use crate::orchestrator::spec::{Step, StepKind, VerifyCheck};
use crate::orchestrator::now_ms;

use std::path::PathBuf;

pub struct DefaultDispatcher;

impl DefaultDispatcher {
    pub fn new() -> Self {
        Self
    }
}

impl Dispatcher for DefaultDispatcher {
    fn id(&self) -> &str {
        "default"
    }

    fn execute(
        &self,
        step: &Step,
        ctx: &mut DispatchContext,
    ) -> Result<StepOutcome, DispatchError> {
        let step_started = now_ms();
        let result = match &step.kind {
            StepKind::Dispatch {
                role_id,
                prompt,
                project,
                session,
            } => dispatch_to_agent(role_id, prompt, project, session, step, ctx),

            StepKind::Shell {
                command,
                cwd,
                timeout_ms,
            } => execute_shell(command, cwd, timeout_ms.as_ref(), step, ctx),

            StepKind::Read { path, max_bytes } => execute_read(path, *max_bytes, step, ctx),

            StepKind::Write {
                path,
                content,
                requires_approval,
            } => execute_write(path, content, *requires_approval, step, ctx),

            StepKind::Reflect { question } => execute_reflect(question, step, ctx),

            StepKind::Verify { check } => execute_verify(check, step, ctx),
        };

        // Fill timing on outcome
        result.map(|mut outcome| {
            if outcome.started_at == 0 {
                outcome.started_at = step_started;
            }
            if outcome.finished_at == 0 {
                outcome.finished_at = now_ms();
            }
            outcome
        })
    }
}

/// Resolve role_id → agent_id from spec, then dispatch to agent subprocess.
fn dispatch_to_agent(
    role_id: &str,
    prompt: &str,
    project: &str,
    session: &Option<String>,
    step: &Step,
    ctx: &mut DispatchContext,
) -> Result<StepOutcome, DispatchError> {
    // Resolve role_id to agent_id from spec.
    // Fallback: if no roles defined in spec, treat role_id as agent_id directly
    // (allows running plans generated without explicit role assignments).
    let agent_id = if let Some(role) = ctx
        .spec
        .roles
        .iter()
        .find(|r| r.role_id == role_id)
    {
        role.agent_id
            .clone()
            .unwrap_or_else(|| role_id.to_string())
    } else if ctx.spec.roles.is_empty() {
        role_id.to_string()
    } else {
        return Err(DispatchError::RoleNotFound(role_id.to_string()));
    };

    let plugin = ctx
        .registry
        .get(&agent_id)
        .ok_or_else(|| DispatchError::AgentNotFound(agent_id.clone()))?;

    let req = ChatRequest {
        project_path: project.to_string(),
        session_id: session.clone(),
        message: prompt.to_string(),
    };

    let mut cmd = plugin.build_chat_command(req);
    if plugin.pipe_chat_stdin() {
        cmd.stdin(std::process::Stdio::piped());
    }
    cmd.stdout(std::process::Stdio::piped());

    // Build a single-threaded tokio runtime for the async child process.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| DispatchError::Other(format!("Runtime: {e}")))?;

    let agent_id_owned = agent_id.to_string();
    let role_id_owned = role_id.to_string();
    let step_id = step.step_id.clone();
    let message_owned = prompt.to_string();
    let pipe_stdin = plugin.pipe_chat_stdin();
    let agent_id_for_spawn = agent_id_owned.clone();

    // Run the subprocess inside the tokio runtime.
    let result = rt.block_on(async move {
        let mut child = cmd
            .spawn()
            .map_err(|e| DispatchError::SpawnFailed(format!("Spawn {agent_id_for_spawn}: {e}")))?;

        // Write the message to stdin if the agent expects it
        if pipe_stdin {
            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(message_owned.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
        }

        // Read stdout line-by-line, parsing NormalizedEvent JSON
        let mut events: Vec<NormalizedEvent> = Vec::new();
        if let Some(stdout) = child.stdout.take() {
            use tokio::io::AsyncBufReadExt;
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(event) = serde_json::from_str::<NormalizedEvent>(&line) {
                    events.push(event);
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| DispatchError::Other(format!("Wait: {e}")))?;

        Ok::<_, DispatchError>((events, status))
    });

    let (events, exit_status) = result?;

    // Emit collected events through trace + emitter (raw, no SubAgentEvent wrapping)
    let mut captured_session_id: Option<String> = None;
    for event in events {
        if let NormalizedEvent::SessionResolved { session_id } = &event {
            captured_session_id = Some(session_id.clone());
        }
        let _ = ctx.trace.append_event(&event);
        (ctx.emitter)(&event);
    }

    // Resolve display name from registry (e.g., "claude-code" -> "Claude Code")
    let display_name = ctx.registry.get(&agent_id_owned).map(|p| p.info().display_name);

    let step_finished = now_ms();
    Ok(StepOutcome {
        step_id,
        role_id: role_id_owned,
        agent_id: agent_id_owned,
        agent_display_name: display_name,
        status: if exit_status.success() {
            StepStatus::Complete
        } else {
            StepStatus::Failed
        },
        output: None,
        session_id: captured_session_id,
        started_at: step_finished, // will be overwritten by execute()
        finished_at: step_finished,
        usage: UsageSummary::zero(),
    ..Default::default()})
}

/// Execute a shell command within the project directory.
fn execute_shell(
    command: &str,
    cwd: &PathBuf,
    timeout_ms: Option<&u64>,
    step: &Step,
    _ctx: &mut DispatchContext,
) -> Result<StepOutcome, DispatchError> {
    let started = now_ms();

    // Build async runtime for the subprocess
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| DispatchError::Other(format!("Runtime: {e}")))?;

    let command_owned = command.to_string();
    let cwd_owned = cwd.clone();
    let timeout = timeout_ms.copied();

    let result = rt.block_on(async move {
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c").arg(&command_owned).current_dir(&cwd_owned);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| DispatchError::SpawnFailed(format!("Shell spawn: {e}")))?;

        let exit_status = if let Some(timeout_ms) = timeout {
            use tokio::time::{timeout, Duration};
            match timeout(Duration::from_millis(timeout_ms), child.wait()).await {
                Ok(Ok(status)) => Ok(status),
                Ok(Err(e)) => Err(DispatchError::Other(format!("Shell wait: {e}"))),
                Err(_) => {
                    let _ = child.kill().await;
                    Err(DispatchError::Other("Shell command timed out".into()))
                }
            }
        } else {
            child
                .wait()
                .await
                .map_err(|e| DispatchError::Other(format!("Shell wait: {e}")))
        };

        // Read stdout/stderr
        let stdout = if let Some(out) = child.stdout.take() {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let mut reader = tokio::io::BufReader::new(out);
            let _ = reader.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).to_string()
        } else {
            String::new()
        };

        let stderr = if let Some(err) = child.stderr.take() {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let mut reader = tokio::io::BufReader::new(err);
            let _ = reader.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).to_string()
        } else {
            String::new()
        };

        Ok::<_, DispatchError>((exit_status, stdout, stderr))
    });

    let (exit_result, stdout, stderr) = result?;
    let finished = now_ms();

    match exit_result {
        Ok(status) => Ok(StepOutcome {
            step_id: step.step_id.clone(),
            role_id: String::new(),
            agent_id: "shell".to_string(),
            status: if status.success() {
                StepStatus::Complete
            } else {
                StepStatus::Failed
            },
            output: Some(serde_json::json!({
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": status.code(),
            })),
            started_at: started,
            finished_at: finished,
            usage: UsageSummary::zero(),
        ..Default::default()}),
        Err(e) => Ok(StepOutcome {
            step_id: step.step_id.clone(),
            role_id: String::new(),
            agent_id: "shell".to_string(),
            status: StepStatus::Failed,
            output: Some(serde_json::json!({ "error": e.to_string() })),
            started_at: started,
            finished_at: finished,
            usage: UsageSummary::zero(),
        ..Default::default()}),
    }
}

/// Read a file within the project directory.
fn execute_read(
    path: &PathBuf,
    max_bytes: u64,
    step: &Step,
    _ctx: &mut DispatchContext,
) -> Result<StepOutcome, DispatchError> {
    let started = now_ms();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| DispatchError::Other(format!("Runtime: {e}")))?;

    let path_owned = path.clone();
    let result = rt.block_on(async move {
        use tokio::io::AsyncReadExt;
        let mut file = tokio::fs::File::open(&path_owned).await.map_err(|e| {
            DispatchError::Other(format!("Cannot open {}: {e}", path_owned.display()))
        })?;
        let mut buf = vec![0u8; max_bytes as usize];
        let n = file.read(&mut buf).await.map_err(|e| {
            DispatchError::Other(format!("Cannot read {}: {e}", path_owned.display()))
        })?;
        buf.truncate(n);
        Ok::<_, DispatchError>(buf)
    });

    let finished = now_ms();

    match result {
        Ok(bytes) => {
            let content = String::from_utf8_lossy(&bytes).to_string();
            Ok(StepOutcome {
                step_id: step.step_id.clone(),
                role_id: String::new(),
                agent_id: "read".to_string(),
                status: StepStatus::Complete,
                output: Some(serde_json::json!({
                    "path": path.to_string_lossy(),
                    "bytes": bytes.len(),
                    "content": content,
                })),
                started_at: started,
                finished_at: finished,
                usage: UsageSummary::zero(),
            ..Default::default()})
        }
        Err(e) => Ok(StepOutcome {
            step_id: step.step_id.clone(),
            role_id: String::new(),
            agent_id: "read".to_string(),
            status: StepStatus::Failed,
            output: Some(serde_json::json!({ "error": e.to_string() })),
            started_at: started,
            finished_at: finished,
            usage: UsageSummary::zero(),
        ..Default::default()}),
    }
}

/// Write a file. If requires_approval is true, pause for user review.
fn execute_write(
    path: &PathBuf,
    content: &str,
    requires_approval: bool,
    step: &Step,
    _ctx: &mut DispatchContext,
) -> Result<StepOutcome, DispatchError> {
    let started = now_ms();

    // If approval required, don't write the file — just return AwaitingApproval
    if requires_approval {
        return Ok(StepOutcome {
            step_id: step.step_id.clone(),
            role_id: String::new(),
            agent_id: "write".to_string(),
            status: StepStatus::AwaitingApproval,
            output: Some(serde_json::json!({
                "path": path.to_string_lossy(),
                "content_preview": content.chars().take(500).collect::<String>(),
                "content_length": content.len(),
                "requires_approval": true,
            })),
            started_at: started,
            finished_at: now_ms(),
            usage: UsageSummary::zero(),
        ..Default::default()});
    }

    // Actually write the file
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| DispatchError::Other(format!("Runtime: {e}")))?;

    let path_owned = path.clone();
    let content_owned = content.to_string();
    let result = rt.block_on(async move {
        // Ensure parent directory exists
        if let Some(parent) = path_owned.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                DispatchError::Other(format!("Cannot create dir {}: {e}", parent.display()))
            })?;
        }
        tokio::fs::write(&path_owned, &content_owned)
            .await
            .map_err(|e| {
                DispatchError::Other(format!("Cannot write {}: {e}", path_owned.display()))
            })
    });

    let finished = now_ms();

    match result {
        Ok(()) => Ok(StepOutcome {
            step_id: step.step_id.clone(),
            role_id: String::new(),
            agent_id: "write".to_string(),
            status: StepStatus::Complete,
            output: Some(serde_json::json!({
                "path": path.to_string_lossy(),
                "bytes_written": content.len(),
            })),
            started_at: started,
            finished_at: finished,
            usage: UsageSummary::zero(),
        ..Default::default()}),
        Err(e) => Ok(StepOutcome {
            step_id: step.step_id.clone(),
            role_id: String::new(),
            agent_id: "write".to_string(),
            status: StepStatus::Failed,
            output: Some(serde_json::json!({ "error": e.to_string() })),
            started_at: started,
            finished_at: finished,
            usage: UsageSummary::zero(),
        ..Default::default()}),
    }
}

/// Reflect step — stub for v0.6, will use DecisionEngine in Stage 6.
fn execute_reflect(
    question: &str,
    step: &Step,
    _ctx: &mut DispatchContext,
) -> Result<StepOutcome, DispatchError> {
    // v0.6 stub: return a placeholder outcome.
    // Full implementation (Stage 6) will call DecisionEngine.
    Ok(StepOutcome {
        step_id: step.step_id.clone(),
        role_id: String::new(),
        agent_id: "jishu-self".to_string(),
        status: StepStatus::Complete,
        output: Some(serde_json::json!({
            "question": question,
            "note": "reflect stub — DecisionEngine not yet wired",
        })),
        started_at: now_ms(),
        finished_at: now_ms(),
        usage: UsageSummary::zero(),
    ..Default::default()})
}

/// Verify step — strongly typed check execution.
fn execute_verify(
    check: &VerifyCheck,
    step: &Step,
    _ctx: &mut DispatchContext,
) -> Result<StepOutcome, DispatchError> {
    let started = now_ms();
    let result = match check {
        VerifyCheck::FileExists { path } => {
            let exists = path.exists();
            (exists, if exists { "File exists" } else { "File not found" })
        }
        VerifyCheck::CommandSuccess { command } => {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| DispatchError::Other(format!("Runtime: {e}")))?;
            let cmd = command.clone();
            let exit_result = rt.block_on(async move {
                tokio::process::Command::new("sh")
                    .arg("-c")
                    .arg(&cmd)
                    .output()
                    .await
                    .map_err(|e| DispatchError::Other(format!("Verify command: {e}")))
            });
            match exit_result {
                Ok(output) => (
                    output.status.success(),
                    if output.status.success() {
                        "Command succeeded"
                    } else {
                        "Command failed"
                    },
                ),
                Err(_) => (false, "Command execution error"),
            }
        }
        VerifyCheck::OutputContains { command, substring } => {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| DispatchError::Other(format!("Runtime: {e}")))?;
            let cmd = command.clone();
            let sub = substring.clone();
            let exit_result = rt.block_on(async move {
                tokio::process::Command::new("sh")
                    .arg("-c")
                    .arg(&cmd)
                    .output()
                    .await
                    .map_err(|e| DispatchError::Other(format!("Verify command: {e}")))
            });
            match exit_result {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    (stdout.contains(&sub), if stdout.contains(&sub) { "Substring found" } else { "Substring not found" })
                }
                Err(_) => (false, "Command execution error"),
            }
        }
    };

    let finished = now_ms();
    Ok(StepOutcome {
        step_id: step.step_id.clone(),
        role_id: String::new(),
        agent_id: "verify".to_string(),
        status: if result.0 {
            StepStatus::Complete
        } else {
            StepStatus::Failed
        },
        output: Some(serde_json::json!({
            "check": check,
            "passed": result.0,
            "message": result.1,
        })),
        started_at: started,
        finished_at: finished,
        usage: UsageSummary::zero(),
    ..Default::default()})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AgentRegistry;
    use crate::orchestrator::spec::{AssignmentMode, Step, StepKind, TaskSpec};
    use crate::orchestrator::trace::TraceRecorder;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn make_test_spec() -> TaskSpec {
        TaskSpec {
            task_id: "ts_test".into(),
            kind: crate::orchestrator::spec::TaskKind::Run,
            message: "test".into(),
            project_path: Some("/tmp".into()),
            roles: vec![crate::orchestrator::spec::RoleAssignment {
                role_id: "dev".into(),
                role_name: "Dev".into(),
                agent_id: Some("test-agent".into()),
                responsibilities: vec![],
                acceptance: vec![],
                can_edit_files: true,
                can_run_commands: true,
                can_receive_rework: false,
            }],
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

    fn make_test_step(kind: StepKind) -> Step {
        Step {
            step_id: "sp_test".to_string(),
            kind,
            depends_on: vec![],
            timeout_ms: None,
        }
    }

    #[test]
    fn default_dispatcher_id() {
        let d = DefaultDispatcher::new();
        assert_eq!(d.id(), "default");
    }

    #[test]
    fn reflect_step_returns_outcome() {
        let d = DefaultDispatcher::new();
        let registry = Arc::new(AgentRegistry::new());
        let spec = make_test_spec();
        let trace = TraceRecorder::create("test_dispatcher_reflect").unwrap();
        let mut emitted: Vec<NormalizedEvent> = Vec::new();

        let mut ctx = DispatchContext {
            registry,
            run_id: "run_test",
            spec: &spec,
            trace: &trace,
            emitter: &mut |e: &NormalizedEvent| emitted.push(e.clone()),
        };

        let step = make_test_step(StepKind::Reflect {
            question: "What is 2+2?".to_string(),
        });

        let outcome = d.execute(&step, &mut ctx).unwrap();
        assert_eq!(outcome.step_id, "sp_test");
        assert_eq!(outcome.agent_id, "jishu-self");
        assert_eq!(outcome.status, StepStatus::Complete);
        assert!(outcome.output.is_some());
    }

    #[test]
    fn dispatch_agent_not_found() {
        let d = DefaultDispatcher::new();
        let registry = Arc::new(AgentRegistry::new());
        let spec = make_test_spec();
        let trace = TraceRecorder::create("test_dispatcher_not_found").unwrap();
        let mut emitted: Vec<NormalizedEvent> = Vec::new();

        let mut ctx = DispatchContext {
            registry,
            run_id: "run_test",
            spec: &spec,
            trace: &trace,
            emitter: &mut |e: &NormalizedEvent| emitted.push(e.clone()),
        };

        let step = make_test_step(StepKind::Dispatch {
            role_id: "dev".to_string(),
            prompt: "hello".to_string(),
            project: "/tmp".to_string(),
            session: None,
        });

        let err = d.execute(&step, &mut ctx).unwrap_err();
        assert!(matches!(err, DispatchError::AgentNotFound(s) if s == "test-agent"));
    }

    #[test]
    fn dispatch_role_not_found() {
        let d = DefaultDispatcher::new();
        let registry = Arc::new(AgentRegistry::new());
        let spec = make_test_spec();
        let trace = TraceRecorder::create("test_dispatcher_role_not_found").unwrap();
        let mut emitted: Vec<NormalizedEvent> = Vec::new();

        let mut ctx = DispatchContext {
            registry,
            run_id: "run_test",
            spec: &spec,
            trace: &trace,
            emitter: &mut |e: &NormalizedEvent| emitted.push(e.clone()),
        };

        let step = make_test_step(StepKind::Dispatch {
            role_id: "nonexistent_role".to_string(),
            prompt: "hello".to_string(),
            project: "/tmp".to_string(),
            session: None,
        });

        let err = d.execute(&step, &mut ctx).unwrap_err();
        assert!(matches!(err, DispatchError::RoleNotFound(s) if s == "nonexistent_role"));
    }

    #[test]
    fn write_step_requires_approval_does_not_write() {
        let d = DefaultDispatcher::new();
        let registry = Arc::new(AgentRegistry::new());
        let spec = make_test_spec();
        let trace = TraceRecorder::create("test_dispatcher_write_approval").unwrap();
        let mut emitted: Vec<NormalizedEvent> = Vec::new();

        let mut ctx = DispatchContext {
            registry,
            run_id: "run_test",
            spec: &spec,
            trace: &trace,
            emitter: &mut |e: &NormalizedEvent| emitted.push(e.clone()),
        };

        let tmp_path = std::env::temp_dir().join(format!(
            "jishu_write_approval_test_{}",
            std::process::id()
        ));
        let step = make_test_step(StepKind::Write {
            path: tmp_path.clone(),
            content: "should not be written".to_string(),
            requires_approval: true,
        });

        let outcome = d.execute(&step, &mut ctx).unwrap();
        assert_eq!(outcome.status, StepStatus::AwaitingApproval);
        // File should NOT exist
        assert!(!tmp_path.exists());
    }

    #[test]
    fn verify_file_exists_check() {
        let d = DefaultDispatcher::new();
        let registry = Arc::new(AgentRegistry::new());
        let spec = make_test_spec();
        let trace = TraceRecorder::create("test_dispatcher_verify").unwrap();
        let mut emitted: Vec<NormalizedEvent> = Vec::new();

        let mut ctx = DispatchContext {
            registry,
            run_id: "run_test",
            spec: &spec,
            trace: &trace,
            emitter: &mut |e: &NormalizedEvent| emitted.push(e.clone()),
        };

        // Test with a path that does not exist
        let step = make_test_step(StepKind::Verify {
            check: VerifyCheck::FileExists { path: PathBuf::from("/nonexistent/file.txt") },
        });
        let outcome = d.execute(&step, &mut ctx).unwrap();
        assert_eq!(outcome.status, StepStatus::Failed);
    }

    #[test]
    fn shell_step_executes() {
        let d = DefaultDispatcher::new();
        let registry = Arc::new(AgentRegistry::new());
        let spec = make_test_spec();
        let trace = TraceRecorder::create("test_dispatcher_shell").unwrap();
        let mut emitted: Vec<NormalizedEvent> = Vec::new();

        let mut ctx = DispatchContext {
            registry,
            run_id: "run_test",
            spec: &spec,
            trace: &trace,
            emitter: &mut |e: &NormalizedEvent| emitted.push(e.clone()),
        };

        let step = make_test_step(StepKind::Shell {
            command: "echo hello_world".to_string(),
            cwd: std::env::temp_dir(),
            timeout_ms: None,
        });
        let outcome = d.execute(&step, &mut ctx).unwrap();
        assert_eq!(outcome.status, StepStatus::Complete);
        let output = outcome.output.unwrap();
        assert!(output["stdout"].as_str().unwrap().contains("hello_world"));
    }
}
