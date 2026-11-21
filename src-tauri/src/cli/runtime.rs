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
    // 需求16：CLI 入口同样先跑数据迁移（GUI/CLI 双入口，文件锁互斥；
    // critical 失败 fail-loud 退出——不在未迁移数据上执行命令）。
    if let Err(e) = crate::migrations::run_pending(None) {
        eprintln!("error: 数据升级未完成，命令已阻止：{e}");
        return ExitCode::FAILURE;
    }
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
        Commands::Plugins { action } => commands::plugins::run(action, ctx),
        Commands::Extensions { action } => commands::extensions::run(action, ctx),
        Commands::TaskArtifact { action } => {
            commands::task_artifact::run_task_artifact(action, ctx)
        }
        Commands::Memory { action } => commands::memory::run(action, ctx),
        Commands::Mcp { action } => commands::mcp::run(action, ctx),
        Commands::Skill { action } => commands::skill::run(action, ctx),
    }
}
