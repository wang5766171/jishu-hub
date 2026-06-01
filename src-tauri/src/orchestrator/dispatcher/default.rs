use super::{DispatchContext, DispatchError, Dispatcher};
use crate::agent::{ChatRequest, NormalizedEvent};
use crate::orchestrator::result::StepOutcome;
use crate::orchestrator::spec::{Step, StepKind};

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
        match &step.kind {
            StepKind::Dispatch {
                agent,
                message,
                project,
                session,
            } => dispatch_to_agent(agent, message, project, session, step, ctx),
            StepKind::Shell { .. } => Err(DispatchError::Unsupported("shell".to_string())),
            StepKind::Read { .. } => Err(DispatchError::Unsupported("read".to_string())),
            StepKind::Write { .. } => Err(DispatchError::Unsupported("write".to_string())),
            StepKind::Reflect { .. } => {
                // Stub: emit a thinking event and return a placeholder outcome
                (ctx.emitter)(&NormalizedEvent::Thinking {
                    delta: "[reflect] stub — not yet implemented".to_string(),
                });
                Ok(StepOutcome {
                    step_id: step.step_id.clone(),
                    agent_id: "jishu-self".to_string(),
                    status: "complete".to_string(),
                    output: Some(serde_json::json!({ "note": "reflect stub" })),
                })
            }
            StepKind::Verify { .. } => Err(DispatchError::Unsupported("verify".to_string())),
        }
    }
}

fn dispatch_to_agent(
    agent_id: &str,
    message: &str,
    project: &str,
    session: &Option<String>,
    step: &Step,
    ctx: &mut DispatchContext,
) -> Result<StepOutcome, DispatchError> {
    let plugin = ctx
        .registry
        .get(agent_id)
        .ok_or_else(|| DispatchError::AgentNotFound(agent_id.to_string()))?;

    let req = ChatRequest {
        project_path: project.to_string(),
        session_id: session.clone(),
        message: message.to_string(),
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
    let agent_id_for_async = agent_id_owned.clone();
    let step_id = step.step_id.clone();
    let run_id = ctx.run_id.to_string();
    let message_owned = message.to_string();
    let pipe_stdin = plugin.pipe_chat_stdin();

    // Run the subprocess inside the tokio runtime.
    // Collect events into a Vec; emit them after the runtime returns so we
    // can borrow ctx.emitter synchronously.
    let result = rt.block_on(async move {
        let mut child = cmd
            .spawn()
            .map_err(|e| DispatchError::SpawnFailed(format!("Spawn {agent_id_for_async}: {e}")))?;

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

    // Emit collected events through the trace + emitter
    for event in events {
        let _ = ctx.trace.append_event(&event);
        let wrapped = NormalizedEvent::SubAgentEvent {
            run_id: run_id.clone(),
            step_id: step.step_id.clone(),
            sub_event: Box::new(event),
        };
        (ctx.emitter)(&wrapped);
    }

    Ok(StepOutcome {
        step_id,
        agent_id: agent_id_owned,
        status: if exit_status.success() {
            "complete"
        } else {
            "error"
        }
        .to_string(),
        output: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AgentRegistry;
    use crate::orchestrator::spec::Step;
    use crate::orchestrator::trace::TraceRecorder;
    use std::sync::Arc;

    fn make_test_step(kind: crate::orchestrator::spec::StepKind) -> Step {
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
    fn unsupported_step_kinds() {
        let d = DefaultDispatcher::new();
        let registry = Arc::new(AgentRegistry::new());
        let trace = TraceRecorder::create("test_dispatcher_unsupported").unwrap();
        let mut emitted: Vec<NormalizedEvent> = Vec::new();

        let mut ctx = DispatchContext {
            registry,
            run_id: "run_test",
            task_id: "task_test",
            trace: &trace,
            emitter: &mut |e: &NormalizedEvent| emitted.push(e.clone()),
        };

        // Shell
        let step = make_test_step(StepKind::Shell {
            command: "echo hi".to_string(),
            cwd: std::path::PathBuf::from("/tmp"),
        });
        let err = d.execute(&step, &mut ctx).unwrap_err();
        assert!(matches!(err, DispatchError::Unsupported(s) if s == "shell"));

        // Read
        let step = make_test_step(StepKind::Read {
            path: std::path::PathBuf::from("/tmp/f.txt"),
        });
        let err = d.execute(&step, &mut ctx).unwrap_err();
        assert!(matches!(err, DispatchError::Unsupported(s) if s == "read"));

        // Write
        let step = make_test_step(StepKind::Write {
            path: std::path::PathBuf::from("/tmp/f.txt"),
            content: "hi".to_string(),
        });
        let err = d.execute(&step, &mut ctx).unwrap_err();
        assert!(matches!(err, DispatchError::Unsupported(s) if s == "write"));

        // Verify
        let step = make_test_step(StepKind::Verify {
            check: "exists".to_string(),
            expect: "true".to_string(),
        });
        let err = d.execute(&step, &mut ctx).unwrap_err();
        assert!(matches!(err, DispatchError::Unsupported(s) if s == "verify"));
    }

    #[test]
    fn reflect_step_stub() {
        let d = DefaultDispatcher::new();
        let registry = Arc::new(AgentRegistry::new());
        let trace = TraceRecorder::create("test_dispatcher_reflect").unwrap();
        let mut emitted: Vec<NormalizedEvent> = Vec::new();

        let mut ctx = DispatchContext {
            registry,
            run_id: "run_test",
            task_id: "task_test",
            trace: &trace,
            emitter: &mut |e: &NormalizedEvent| emitted.push(e.clone()),
        };

        let step = make_test_step(StepKind::Reflect {
            question: "What is 2+2?".to_string(),
        });

        let outcome = d.execute(&step, &mut ctx).unwrap();
        assert_eq!(outcome.step_id, "sp_test");
        assert_eq!(outcome.agent_id, "jishu-self");
        assert_eq!(outcome.status, "complete");
        assert!(outcome.output.is_some());

        // A Thinking event should have been emitted
        assert_eq!(emitted.len(), 1);
        assert!(matches!(&emitted[0], NormalizedEvent::Thinking { .. }));
    }

    #[test]
    fn dispatch_agent_not_found() {
        let d = DefaultDispatcher::new();
        let registry = Arc::new(AgentRegistry::new());
        let trace = TraceRecorder::create("test_dispatcher_not_found").unwrap();
        let mut emitted: Vec<NormalizedEvent> = Vec::new();

        let mut ctx = DispatchContext {
            registry,
            run_id: "run_test",
            task_id: "task_test",
            trace: &trace,
            emitter: &mut |e: &NormalizedEvent| emitted.push(e.clone()),
        };

        let step = make_test_step(StepKind::Dispatch {
            agent: "nonexistent-agent".to_string(),
            message: "hello".to_string(),
            project: "/tmp".to_string(),
            session: None,
        });

        let err = d.execute(&step, &mut ctx).unwrap_err();
        assert!(matches!(err, DispatchError::AgentNotFound(s) if s == "nonexistent-agent"));
    }
}
