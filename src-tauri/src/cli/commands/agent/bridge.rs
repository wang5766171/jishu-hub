use std::io::Read;
use std::sync::{Arc, Mutex};

use crate::agent::jishu_self::{pi_events, pi_model, pi_runtime, pi_session};
use crate::agent::normalized::NormalizedEvent;
use crate::agent::{AgentRegistry, ChatRequest};
use crate::cli::args::AgentBridgeAction;
use crate::cli::error::CliError;
use crate::cli::jsonl::JsonlWriter;
use crate::cli::output::ExecutionContext;

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
        return run_jishu_self(message, session, project);
    }

    run_other_agent(agent_id, message, project, session)
}

/// Run jishu-self through the Pi coding-agent runtime in JSON mode. Jishu stays
/// the public entrypoint; Pi provides the agent loop, tools, and session runtime.
fn run_jishu_self(
    message: String,
    session: Option<String>,
    project_path: String,
) -> Result<(), CliError> {
    let writer = Arc::new(Mutex::new(JsonlWriter::stdout()));

    let runtime = match pi_runtime::resolve_pi_runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            emit_bridge_error(&writer, &error)?;
            return Err(CliError::Internal(error));
        }
    };

    let model_args = match pi_model::build_pi_model_args_from_active() {
        Ok(args) => args,
        Err(error) => {
            emit_bridge_error(&writer, &error)?;
            return Err(CliError::Internal(error));
        }
    };

    let session_dir = match pi_session::pi_session_dir(&project_path) {
        Ok(path) => path,
        Err(error) => {
            emit_bridge_error(&writer, &error)?;
            return Err(CliError::Internal(error));
        }
    };
    std::fs::create_dir_all(&session_dir).map_err(CliError::Io)?;

    let pi_args =
        pi_runtime::build_pi_process_args(&session_dir, session.as_deref(), &model_args, &message);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| CliError::Internal(e.to_string()))?;

    rt.block_on(run_pi_runtime_process(
        writer,
        runtime,
        pi_args,
        project_path,
    ))
}

async fn run_pi_runtime_process(
    writer: Arc<Mutex<JsonlWriter>>,
    runtime: pi_runtime::PiRuntimeCommand,
    mut pi_args: Vec<String>,
    project_path: String,
) -> Result<(), CliError> {
    let mut cmd = tokio::process::Command::new(&runtime.program);
    cmd.args(&runtime.base_args)
        .args(&pi_args)
        .current_dir(&project_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Append a jishu-specific identity hint so the model doesn't
    // parrot Pi's default "I am Pi" line. Pi accepts multiple
    // `--append-system-prompt` flags and concatenates them onto the
    // coding-assistant default prompt.
    cmd.arg("--append-system-prompt");
    cmd.arg(JISHU_AGENT_IDENTITY_PROMPT);

    // Pin Pi's config dir to ~/.jishu-agent/ so the bundled Pi reads
    // models.json / auth.json / sessions from the jishu-owned tree.
    // Without this, Pi would use ~/.pi/agent/ which is the user-facing
    // install's tree — but jishu's Pi is a submodule fork, not a user
    // install, so it should keep all its state under jishu's home.
    if let Some(jishu_agent_dir) = pi_agent_dir() {
        cmd.env("PI_CODING_AGENT_DIR", &jishu_agent_dir);
    }

    crate::process_command::tokio_no_window(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!("Failed to spawn Pi runtime: {error}");
            emit_bridge_error(&writer, &message)?;
            return Err(CliError::Internal(message));
        }
    };

    let stderr_task = child.stderr.take().map(|mut stderr| {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buffer = String::new();
            let _ = stderr.read_to_string(&mut buffer).await;
            buffer
        })
    });

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CliError::Internal("Pi runtime stdout was not piped".to_string()))?;

    {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|e| CliError::Internal(e.to_string()))?
        {
            if line.trim().is_empty() {
                continue;
            }

            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(value) => {
                    for event in pi_events::convert_pi_event(value) {
                        emit(&writer, &event)?;
                    }
                }
                Err(_) => {
                    emit(
                        &writer,
                        &NormalizedEvent::Raw {
                            agent: "jishu-pi".to_string(),
                            raw: serde_json::json!({ "line": line }),
                        },
                    )?;
                }
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| CliError::Internal(e.to_string()))?;
    let stderr = match stderr_task {
        Some(task) => task.await.unwrap_or_default(),
        None => String::new(),
    };

    if !status.success() {
        let stderr = stderr.trim();
        let message = if stderr.is_empty() {
            format!("Pi runtime exited with code: {:?}", status.code())
        } else {
            format!("Pi runtime exited with code {:?}: {stderr}", status.code())
        };
        emit_bridge_error(&writer, &message)?;
        return Err(CliError::Internal(message));
    }

    Ok(())
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

fn emit_bridge_error(writer: &Arc<Mutex<JsonlWriter>>, message: &str) -> Result<(), CliError> {
    emit(
        writer,
        &NormalizedEvent::Error {
            message: message.to_string(),
            recoverable: false,
        },
    )
}

/// Absolute path to `~/.jishu-agent/`, used as the value of
/// `PI_CODING_AGENT_DIR` so Pi uses jishu-owned state instead of
/// `~/.pi/agent/`. Returns `None` if the home directory can't be
/// determined (in which case Pi will fall back to its default).
fn pi_agent_dir() -> Option<String> {
    let home = dirs::home_dir()?;
    Some(home.join(".jishu-agent").to_string_lossy().to_string())
}

/// Appended to Pi's default system prompt via `--append-system-prompt`.
/// Keeps the model from claiming to be Pi / Claude / any other upstream
/// product when asked "who you are", and frames jishu agent as a
/// general-purpose desktop assistant (not just a coding bot) so that
/// future skill integrations don't have to fight a coding-specific
/// self-image.
///
/// Phrased in English because the Anthropic protocol's system prompt
/// is processed as-is; the language of the response is steered by
/// the explicit "reply in the same language the user used" line.
const JISHU_AGENT_IDENTITY_PROMPT: &str = "You are the jishu agent — a general-purpose \
desktop assistant running inside the Jishu Hub desktop app. You help the user with \
whatever they need: writing and editing code, reading and drafting documents, \
researching topics, planning tasks, running skills and tools exposed by the app, \
and so on. When asked who you are, introduce yourself as jishu agent and \
describe your role as a general-purpose assistant inside Jishu Hub. Never claim \
to be Pi, Claude, or any other upstream product; never mention the underlying \
runtime. Address the user as the human in front of the app. Reply in the same \
language the user used.";
