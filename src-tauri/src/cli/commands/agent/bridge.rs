use std::io::Read;
use std::sync::{Arc, Mutex};

use crate::agent::normalized::{NormalizedEvent, TurnEndReason};
use crate::agent::{AgentRegistry, ChatRequest};
use crate::cli::args::AgentBridgeAction;
use crate::cli::error::CliError;
use crate::cli::jsonl::JsonlWriter;
use crate::cli::output::ExecutionContext;
use crate::llm::config::ModelStore;
use crate::llm::message::{LlmMessage, LlmRequest, LlmRole, StopReason};
use crate::llm::{create_provider, CancelToken};

pub fn run(action: AgentBridgeAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        AgentBridgeAction::Start {
            agent,
            session,
            project,
        } => start(agent, session, project, ctx),
        AgentBridgeAction::List => {
            println!("No active bridges.");
            Ok(())
        }
        AgentBridgeAction::Stop { bridge_id } => {
            Err(CliError::Internal(format!("Bridge {bridge_id} not found")))
        }
    }
}

fn start(
    agent_id: String,
    session: Option<String>,
    project: String,
    _ctx: &ExecutionContext,
) -> Result<(), CliError> {
    let mut message = String::new();
    std::io::stdin()
        .read_to_string(&mut message)
        .map_err(CliError::Io)?;
    let message = message.trim_end().to_string();

    if message.is_empty() {
        return Err(CliError::InvalidArg(
            "No message provided on stdin".to_string(),
        ));
    }

    if agent_id == "jishu-self" {
        return run_jishu_self(message, session);
    }

    run_other_agent(agent_id, message, project, session)
}

/// Run jishu-self's own LLM loop in-process. Loads the active model preset from
/// `~/.jishu-agent/models.json`, calls the provider's stream_chat, and emits
/// NormalizedEvent JSON-lines to stdout.
fn run_jishu_self(message: String, session: Option<String>) -> Result<(), CliError> {
    let writer = Arc::new(Mutex::new(JsonlWriter::stdout()));
    let session_id = session.unwrap_or_else(|| format!("jishu-self-{}", std::process::id()));

    emit(&writer, &NormalizedEvent::SessionResolved { session_id })?;

    let store = ModelStore::load().map_err(|e| CliError::Internal(e))?;
    let preset = store
        .get_active()
        .ok_or_else(|| {
            CliError::Internal(
                "No active model — configure one in GUI or edit ~/.jishu-agent/models.json"
                    .to_string(),
            )
        })?
        .clone();

    let provider = create_provider(&preset).map_err(CliError::Internal)?;

    let req = LlmRequest {
        model: preset.model.clone(),
        messages: vec![LlmMessage {
            role: LlmRole::User,
            content: Some(message),
            tool_calls: None,
            tool_call_id: None,
        }],
        tools: vec![],
        stream: true,
        max_tokens: Some(preset.max_tokens),
        temperature: Some(preset.temperature),
    };

    let cancel = CancelToken::new();
    let writer_for_emit = writer.clone();
    let emitter = Box::new(move |event: NormalizedEvent| {
        if let Ok(mut w) = writer_for_emit.lock() {
            let _ = w.emit(&event);
        }
    });

    let rt = tokio::runtime::Runtime::new().map_err(|e| CliError::Internal(e.to_string()))?;
    rt.block_on(async {
        let result = provider.stream_chat(req, emitter, &cancel).await;
        match result {
            Ok(_turn) => Ok(()),
            Err(e) => {
                emit(
                    &writer,
                    &NormalizedEvent::Error {
                        message: e.to_string(),
                        recoverable: false,
                    },
                )?;
                Err(CliError::Internal(format!("LLM stream failed: {e}")))
            }
        }
    })
}

/// Spawn another agent's CLI and relay its stdout as NormalizedEvents.
fn run_other_agent(
    agent_id: String,
    message: String,
    project_path: String,
    session_id: Option<String>,
) -> Result<(), CliError> {
    let registry = AgentRegistry::new();
    let target = registry
        .agents_info()
        .iter()
        .find(|(id, _)| *id == agent_id)
        .map(|(_, a)| *a)
        .ok_or_else(|| CliError::NotFound(format!("Agent not found: {agent_id}")))?;

    let req = ChatRequest {
        project_path,
        session_id,
        message: message.clone(),
    };

    let mut cmd = target.build_chat_command(req);
    if target.pipe_chat_stdin() {
        cmd.stdin(std::process::Stdio::piped());
    }
    cmd.stdout(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| CliError::Internal(format!("Failed to spawn target agent: {e}")))?;

    let writer = Arc::new(Mutex::new(JsonlWriter::stdout()));
    let sid = format!("bridge-{}", std::process::id());
    emit(
        &writer,
        &NormalizedEvent::SessionResolved { session_id: sid },
    )?;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| CliError::Internal(e.to_string()))?;

    let writer_clone = writer.clone();
    let agent_id_clone = agent_id.clone();

    rt.block_on(async {
        if target.pipe_chat_stdin() {
            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                stdin.write_all(message.as_bytes()).await.ok();
                drop(stdin);
            }
        }

        if let Some(stdout) = child.stdout.take() {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Some(line) = lines
                .next_line()
                .await
                .map_err(|e| CliError::Internal(e.to_string()))?
            {
                if let Ok(event) = serde_json::from_str::<NormalizedEvent>(&line) {
                    emit(&writer_clone, &event)?;
                } else if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    emit(
                        &writer_clone,
                        &NormalizedEvent::Raw {
                            agent: agent_id_clone.clone(),
                            raw: value,
                        },
                    )?;
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| CliError::Internal(e.to_string()))?;
        if !status.success() {
            emit(
                &writer_clone,
                &NormalizedEvent::Error {
                    message: format!("Agent exited with code: {:?}", status.code()),
                    recoverable: false,
                },
            )?;
        }

        Ok::<(), CliError>(())
    })?;

    Ok(())
}

fn emit(writer: &Arc<Mutex<JsonlWriter>>, event: &NormalizedEvent) -> Result<(), CliError> {
    let mut w = writer
        .lock()
        .map_err(|e| CliError::Internal(format!("Writer lock poisoned: {e}")))?;
    w.emit(event)
        .map_err(|e| CliError::Internal(format!("Failed to write event: {e}")))
}
