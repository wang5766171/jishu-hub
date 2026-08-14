use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::agent::jishu_self::{pi_model, pi_runtime, pi_session};
use crate::agent::normalized::ContentBlock;
use crate::agent::{AgentRegistry, ConfigSurface, NormalizedEvent};
use crate::agent_runtime::{run_turn_blocking, AgentTurnRequest};
use crate::cli::args::ChatAction;
use crate::cli::error::CliError;
use crate::cli::jsonl::JsonlWriter;
use crate::cli::output::ExecutionContext;

pub fn run(action: ChatAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        ChatAction::Start { agent, project } => start(agent, project),
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
    if no_wait {
        return Err(CliError::InvalidArg(
            "--no-wait is not supported by the unified AgentRuntime send path".to_string(),
        ));
    }

    let registry = AgentRegistry::new();
    if registry.get(&agent_id).is_none() {
        return Err(CliError::NotFound(format!("Agent not found: {agent_id}")));
    }

    let output = run_turn_blocking(
        &registry,
        AgentTurnRequest {
            agent_id,
            project_path: project,
            session_id: session,
            message: msg,
            timeout_secs: 600,
        },
        None,
    )
    .map_err(CliError::Internal)?;

    emit_runtime_events(&output.events, stream_json)?;
    if !output.exit_success {
        return Err(CliError::Internal(format!(
            "Agent failed: {:?}",
            output.exit_code
        )));
    }
    Ok(())
}

fn emit_runtime_events(events: &[NormalizedEvent], stream_json: bool) -> Result<(), CliError> {
    if stream_json {
        let mut writer = JsonlWriter::stdout();
        for event in events {
            writer
                .emit(event)
                .map_err(|e| CliError::Internal(e.to_string()))?;
        }
        return Ok(());
    }

    for event in events {
        match event {
            NormalizedEvent::TextDelta { delta } | NormalizedEvent::Thinking { delta } => {
                print!("{delta}");
            }
            NormalizedEvent::Message { content } => {
                for block in content {
                    print_content_block(block);
                }
            }
            NormalizedEvent::Error { message, .. } => eprintln!("{message}"),
            _ => {}
        }
    }
    std::io::stdout().flush().map_err(CliError::Io)
}

fn print_content_block(block: &ContentBlock) {
    match block {
        ContentBlock::Text { text } => print!("{text}"),
        ContentBlock::Thinking { thinking } => print!("{thinking}"),
        _ => {}
    }
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

fn start(agent_id: String, project: String) -> Result<(), CliError> {
    let registry = AgentRegistry::new();
    let agent = registry
        .get(&agent_id)
        .ok_or_else(|| CliError::NotFound(format!("Agent not found: {agent_id}")))?;
    if matches!(agent.config_surface(), ConfigSurface::ModelStore { .. }) {
        return run_jishu_self_interactive(&project, None);
    }
    run_native_interactive(agent, &project, None)
}

fn resume(id: &str) -> Result<(), CliError> {
    let location = pi_session::find_pi_session_location(id).map_err(CliError::Internal)?;
    run_jishu_self_interactive(&location.project_path, Some(location.path.as_path()))
}

fn run_jishu_self_interactive(
    project_path: &str,
    session_file: Option<&Path>,
) -> Result<(), CliError> {
    let runtime = pi_runtime::resolve_pi_runtime().map_err(CliError::Internal)?;
    let model_args = pi_model::build_pi_model_args_from_active().map_err(CliError::Internal)?;
    let sessions_root = pi_session::pi_sessions_root().map_err(CliError::Internal)?;
    std::fs::create_dir_all(&sessions_root).map_err(CliError::Io)?;

    let invocation = build_jishu_self_interactive_invocation(
        runtime,
        &sessions_root,
        session_file,
        &model_args,
        project_path,
    );
    run_process_in_current_terminal(invocation)
}

fn run_native_interactive(
    agent: &(dyn crate::agent::traits::AgentPlugin + Send + Sync),
    project_path: &str,
    session_id: Option<&str>,
) -> Result<(), CliError> {
    let command = session_id
        .map(|sid| agent.build_resume_command(sid))
        .unwrap_or_else(|| agent.build_launch_command());
    run_shell_command_in_current_terminal(&command, project_path)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessInvocation {
    program: PathBuf,
    args: Vec<String>,
    cwd: String,
    envs: Vec<(String, String)>,
}

fn build_jishu_self_interactive_invocation(
    runtime: pi_runtime::PiRuntimeCommand,
    sessions_root: &Path,
    session_file: Option<&Path>,
    model_args: &[String],
    project_path: &str,
) -> ProcessInvocation {
    let mut args = runtime.base_args;
    args.extend(pi_runtime::build_pi_interactive_args(
        sessions_root,
        session_file,
        model_args,
    ));
    args.push("--append-system-prompt".to_string());
    args.push(crate::agent::jishu_self::JISHU_AGENT_IDENTITY_PROMPT.to_string());

    let mut envs = Vec::new();
    envs.push(("PI_SKIP_VERSION_CHECK".to_string(), "1".to_string()));

    ProcessInvocation {
        program: runtime.program,
        args,
        cwd: project_path.to_string(),
        envs,
    }
}

fn run_process_in_current_terminal(invocation: ProcessInvocation) -> Result<(), CliError> {
    let mut cmd = std::process::Command::new(&invocation.program);
    cmd.args(&invocation.args)
        .current_dir(&invocation.cwd)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    for (key, value) in invocation.envs {
        cmd.env(key, value);
    }
    let status = cmd.status().map_err(CliError::Io)?;
    if status.success() {
        Ok(())
    } else {
        Err(CliError::Internal(format!(
            "Interactive agent exited with: {:?}",
            status.code()
        )))
    }
}

fn run_shell_command_in_current_terminal(command: &str, cwd: &str) -> Result<(), CliError> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", command]);
        cmd
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-lc", command]);
        cmd
    };

    let status = cmd
        .current_dir(cwd)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(CliError::Io)?;
    if status.success() {
        Ok(())
    } else {
        Err(CliError::Internal(format!(
            "Interactive command exited with: {:?}",
            status.code()
        )))
    }
}

fn abort(_id: &str) -> Result<(), CliError> {
    Err(CliError::Internal("abort: not yet implemented".to_string()))
}

fn tail(_id: &str) -> Result<(), CliError> {
    Err(CliError::Internal("tail: not yet implemented".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::jishu_self::pi_runtime::{PiRuntimeCommand, PiRuntimeSource};

    #[test]
    fn jishu_interactive_invocation_uses_pi_without_bridge_or_json_mode() {
        let runtime = PiRuntimeCommand {
            program: PathBuf::from("node"),
            base_args: vec!["D:\\pi\\packages\\coding-agent\\dist\\cli.js".to_string()],
            source: PiRuntimeSource::BinEnv,
        };
        let model_args = vec![
            "--provider".to_string(),
            "anthropic".to_string(),
            "--model".to_string(),
            "claude-sonnet-4-5".to_string(),
        ];

        let invocation = build_jishu_self_interactive_invocation(
            runtime,
            Path::new(r"D:\sessions"),
            Some(Path::new(
                r"D:\sessions\--D-Work-app--\2026-06-06T00-00-00.000Z_sid-1.jsonl",
            )),
            &model_args,
            r"D:\Work\app",
        );

        assert_eq!(invocation.program, PathBuf::from("node"));
        assert_eq!(invocation.cwd, r"D:\Work\app");
        assert!(invocation.args.iter().any(|arg| arg == "--session-dir"));
        assert!(invocation.args.iter().any(|arg| arg == "--session"));
        assert!(invocation
            .args
            .iter()
            .any(|arg| arg.ends_with("2026-06-06T00-00-00.000Z_sid-1.jsonl")));
        assert!(invocation
            .args
            .iter()
            .any(|arg| arg == "--append-system-prompt"));
        assert!(!invocation.args.iter().any(|arg| arg == "agent-bridge"));
        assert!(!invocation.args.iter().any(|arg| arg == "--mode"));
    }
}
