use std::process::ExitCode;

use crate::cli::args::{Cli, Commands};
use crate::cli::commands;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

/// Top-level entry point for the CLI binary.
pub fn run(cli: Cli) -> ExitCode {
    // Initialise tracing if requested.
    if let Some(level) = &cli.log {
        let filter = tracing_subscriber::EnvFilter::try_new(level)
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .init();
    }

    let ctx = ExecutionContext::new(cli.json);
    let result = dispatch(cli.command, &ctx);

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(e.exit_code() as u8)
        }
    }
}

/// Dispatch a top-level command to the appropriate handler.
fn dispatch(cmd: Commands, ctx: &ExecutionContext) -> Result<(), CliError> {
    match cmd {
        Commands::Agents { action } => commands::agents::run(action, ctx),
        Commands::Projects { action } => commands::projects::run(action, ctx),
        Commands::Sessions { action } => commands::sessions::run(action, ctx),
        Commands::Chat { action } => commands::chat::run(action, ctx),
        Commands::Config { action } => commands::config_cmd::run(action, ctx),
        Commands::Doctor { fix, format, only } => commands::doctor::run(fix, &format, only.as_deref(), ctx),
        Commands::Plan { action } => commands::plan::run(action, ctx),
        Commands::Task { action } => commands::task::run(action, ctx),
        Commands::Event { action } => commands::event::run(action, ctx),
        Commands::Run {
            prompt,
            agent,
            project,
        } => commands::run::run(&prompt, agent.as_deref(), &project, ctx),
        Commands::Model { action } => commands::model::run(action, ctx),
        Commands::Daemon { action } => commands::daemon::run(action, ctx),
        Commands::Evolve {
            plan,
            project,
            dry_run,
        } => commands::evolve::run(plan.as_deref(), &project, dry_run, ctx),
        Commands::Acp { action } => commands::acp::run(action, ctx),
        Commands::AgentBridge { action } => commands::bridge::run(action, ctx),
    }
}
