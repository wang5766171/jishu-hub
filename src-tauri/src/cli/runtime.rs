use std::process::ExitCode;

use crate::cli::args::{Cli, Commands};
use crate::cli::commands;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

/// Top-level entry point for the CLI binary.
pub fn run(cli: Cli) -> ExitCode {
    if let Some(level) = &cli.log {
        let filter = tracing_subscriber::EnvFilter::try_new(level)
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
        tracing_subscriber::fmt().with_env_filter(filter).init();
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

fn dispatch(cmd: Commands, ctx: &ExecutionContext) -> Result<(), CliError> {
    match cmd {
        Commands::Agents { action } => commands::orchestrator::agents::run(action, ctx),
        Commands::Chat { action } => commands::agent::chat::run(action, ctx),
        Commands::Doctor { fix, format, only } => {
            commands::doctor::run(fix, &format, only.as_deref(), ctx)
        }
        Commands::Plan { action } => commands::orchestrator::plan::run(action, ctx),
        Commands::Task { action } => commands::orchestrator::task::run(action, ctx),
        Commands::Event { action } => commands::orchestrator::event::run(action, ctx),
        Commands::Run {
            prompt,
            agent,
            project,
        } => commands::agent::run::run(&prompt, agent.as_deref(), &project, ctx),
        Commands::Model { action } => commands::agent::model::run(action, ctx),
        Commands::Daemon { action } => commands::orchestrator::daemon::run(action, ctx),
        Commands::Evolve {
            plan,
            project,
            dry_run,
        } => commands::orchestrator::evolve::run(plan.as_deref(), &project, dry_run, ctx),
        Commands::Acp { action } => commands::acp::run(action, ctx),
    }
}
