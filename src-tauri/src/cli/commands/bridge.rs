use crate::agent::{AgentRegistry, ChatRequest, NormalizedEvent};
use crate::cli::args::AgentBridgeAction;
use crate::cli::error::CliError;
use crate::cli::jsonl::JsonlWriter;
use crate::cli::output::ExecutionContext;

pub fn run(action: AgentBridgeAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        AgentBridgeAction::Start { agent, transport } => start(agent, transport, ctx),
        AgentBridgeAction::List => {
            println!("No active bridges.");
            Ok(())
        }
        AgentBridgeAction::Stop { bridge_id } => {
            Err(CliError::Internal(format!("Bridge {bridge_id} not found")))
        }
    }
}

fn start(agent_id: String, _transport: String, _ctx: &ExecutionContext) -> Result<(), CliError> {
    // Read message from stdin (the orchestrator writes the user message to our stdin)
    use std::io::Read;
    let mut message = String::new();
    std::io::stdin().read_to_string(&mut message).map_err(CliError::Io)?;
    let message = message.trim_end().to_string();

    if message.is_empty() {
        return Err(CliError::InvalidArg("No message provided on stdin".to_string()));
    }

    // Resolve target agent
    let registry = AgentRegistry::new();
    // Don't recurse into jishu-self — pick the first non-self agent
    let target: &(dyn crate::agent::AgentPlugin + Send + Sync) = registry.agents_info()
        .iter()
        .find(|(id, _)| *id != "jishu-self" && *id == agent_id)
        .map(|(_, a)| *a)
        .or_else(|| registry.agents_info().iter().find(|(id, _)| *id != "jishu-self").map(|(_, a)| *a))
        .ok_or_else(|| CliError::NotFound("No target agent available".to_string()))?;

    let req = ChatRequest {
        project_path: ".".to_string(),
        session_id: None,
        message: message.clone(),
    };

    let mut cmd = target.build_chat_command(req);
    if target.pipe_chat_stdin() {
        cmd.stdin(std::process::Stdio::piped());
    }
    cmd.stdout(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| CliError::Internal(format!("Failed to spawn target agent: {e}")))?;

    let mut writer = JsonlWriter::stdout();

    // Emit session resolved event
    let sid = format!("bridge-{}", std::process::id());
    writer.emit(&NormalizedEvent::SessionResolved { session_id: sid.clone() })
        .map_err(|e| CliError::Internal(e.to_string()))?;

    // Create tokio runtime for async stdin/stdout handling
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| CliError::Internal(e.to_string()))?;

    let message_clone = message.clone();
    let agent_id_clone = agent_id.clone();

    rt.block_on(async {
        // Write message to target's stdin if needed
        if target.pipe_chat_stdin() {
            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                stdin.write_all(message_clone.as_bytes()).await.ok();
                drop(stdin);
            }
        }

        // Relay stdout
        if let Some(stdout) = child.stdout.take() {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Some(line) = lines.next_line().await.map_err(|e| CliError::Internal(e.to_string()))? {
                // Try to parse as NormalizedEvent, otherwise emit as Raw
                if let Ok(event) = serde_json::from_str::<NormalizedEvent>(&line) {
                    writer.emit(&event).map_err(|e| CliError::Internal(e.to_string()))?;
                } else {
                    writer.emit(&NormalizedEvent::Raw {
                        agent: agent_id_clone.clone(),
                        raw: serde_json::Value::String(line),
                    }).map_err(|e| CliError::Internal(e.to_string()))?;
                }
            }
        }

        let status = child.wait().await.map_err(|e| CliError::Internal(e.to_string()))?;
        if !status.success() {
            writer.emit(&NormalizedEvent::Error {
                message: format!("Agent exited with code: {:?}", status.code()),
                recoverable: false,
            }).map_err(|e| CliError::Internal(e.to_string()))?;
        }

        Ok::<(), CliError>(())
    })?;

    Ok(())
}
