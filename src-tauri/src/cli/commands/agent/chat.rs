use std::io::Read;

use crate::agent::{AgentRegistry, ChatRequest};
use crate::cli::args::ChatAction;
use crate::cli::error::CliError;
use crate::cli::jsonl::JsonlWriter;
use crate::cli::output::ExecutionContext;

pub fn run(action: ChatAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        ChatAction::Send {
            agent,
            project,
            message,
            message_file,
            message_stdin,
            session,
            stream_json,
            no_wait,
        } => send(
            agent,
            project,
            message,
            message_file,
            message_stdin,
            session,
            stream_json,
            no_wait,
        ),
        ChatAction::Resume { id } => resume(&id),
        ChatAction::Abort { id } => abort(&id),
        ChatAction::Tail { id } => tail(&id),
    }
}

fn send(
    agent_id: String,
    project: String,
    message: Option<String>,
    message_file: Option<String>,
    message_stdin: bool,
    session: Option<String>,
    stream_json: bool,
    no_wait: bool,
) -> Result<(), CliError> {
    let msg = resolve_message(message, message_file, message_stdin)?;

    let registry = AgentRegistry::new();
    let agent = registry
        .get(&agent_id)
        .ok_or_else(|| CliError::NotFound(format!("Agent not found: {agent_id}")))?;

    let req = ChatRequest {
        project_path: project,
        session_id: session,
        message: msg.clone(),
    };

    let mut cmd = agent.build_chat_command(req);

    // Pipe stdin so we can write the message to the subprocess.
    let needs_stdin = agent.pipe_chat_stdin();
    if needs_stdin {
        cmd.stdin(std::process::Stdio::piped());
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(CliError::Io)?;

    rt.block_on(async {
        let mut child = cmd.spawn().map_err(CliError::Io)?;

        // Write message to subprocess stdin and close it.
        if needs_stdin {
            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                stdin
                    .write_all(msg.as_bytes())
                    .await
                    .map_err(CliError::Io)?;
                stdin.shutdown().await.map_err(CliError::Io)?;
            }
        }

        if no_wait {
            let pid = child.id().unwrap_or(0);
            println!("Started with PID: {pid}");
            return Ok(());
        }

        if stream_json {
            let writer = JsonlWriter::stdout();
            if let Some(stdout) = child.stdout.take() {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                let mut writer = writer;
                while let Some(line) = lines.next_line().await.map_err(CliError::Io)? {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                        writer
                            .emit(&value)
                            .map_err(|e| CliError::Internal(e.to_string()))?;
                    } else {
                        println!("{line}");
                    }
                }
            }
            let status = child.wait().await.map_err(CliError::Io)?;
            if !status.success() {
                return Err(CliError::Internal(format!(
                    "Agent exited with: {:?}",
                    status.code()
                )));
            }
        } else {
            let output = child.wait_with_output().await.map_err(CliError::Io)?;
            print!("{}", String::from_utf8_lossy(&output.stdout));
            if !output.status.success() {
                eprintln!("{}", String::from_utf8_lossy(&output.stderr));
                return Err(CliError::Internal(format!(
                    "Agent failed: {:?}",
                    output.status.code()
                )));
            }
        }

        Ok(())
    })
}

fn resolve_message(
    message: Option<String>,
    message_file: Option<String>,
    message_stdin: bool,
) -> Result<String, CliError> {
    let sources = [message.is_some(), message_file.is_some(), message_stdin];
    let count = sources.iter().filter(|&&x| x).count();
    if count > 1 {
        return Err(CliError::InvalidArg(
            "--message, --message-file, --message-stdin are mutually exclusive".to_string(),
        ));
    }
    if let Some(msg) = message {
        return Ok(msg);
    }
    if let Some(path) = message_file {
        return std::fs::read_to_string(&path).map_err(CliError::Io);
    }
    if message_stdin {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(CliError::Io)?;
        return Ok(buf);
    }
    Err(CliError::InvalidArg(
        "One of --message, --message-file, --message-stdin is required".to_string(),
    ))
}

fn resume(_id: &str) -> Result<(), CliError> {
    Err(CliError::Internal(
        "resume: not yet implemented".to_string(),
    ))
}

fn abort(_id: &str) -> Result<(), CliError> {
    Err(CliError::Internal("abort: not yet implemented".to_string()))
}

fn tail(_id: &str) -> Result<(), CliError> {
    Err(CliError::Internal("tail: not yet implemented".to_string()))
}
