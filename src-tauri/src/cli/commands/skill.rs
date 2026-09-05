//! `jishu-cli skill` 子命令（v0.9.0 需求20）：skill 分发服务管理。

use crate::agent::skill_deploy;
use crate::cli::args::SkillAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: SkillAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        // 显式命令 = 显式意图：忽略解析器门控强制分发（对标 mcp inject）。
        SkillAction::Deploy => {
            let report = skill_deploy::sync_skill_deployments(true);
            print_report(&report, ctx);
            Ok(())
        }
        SkillAction::Remove => {
            let report = skill_deploy::remove_all_deployed();
            print_report(&report, ctx);
            Ok(())
        }
        SkillAction::Status => {
            status(ctx);
            Ok(())
        }
    }
}

fn print_report(report: &skill_deploy::SkillSyncReport, _ctx: &ExecutionContext) {
    if report.actions.is_empty() {
        println!("(no changes)");
    } else {
        for line in &report.actions {
            println!("{line}");
        }
    }
}

fn status(_ctx: &ExecutionContext) {
    let resolver_on = crate::agent::plugin::is_skill_resolver_enabled();
    println!(
        "skill-resolver: {}",
        if resolver_on { "enabled" } else { "disabled" }
    );
    let targets = skill_deploy::skill_targets();
    println!("targets ({}):", targets.len());
    for (agent_id, root) in &targets {
        println!("  {agent_id} -> {}", root.display());
    }
    let decls = skill_deploy::load_skill_decls();
    if decls.is_empty() {
        println!("skills: (none enabled)");
    } else {
        println!("skills ({}):", decls.len());
        for (id, description, _) in &decls {
            println!("  {id}: {description}");
        }
    }
    if resolver_on {
        println!("(sync runs at app start / plugin enable-disable; use `skill deploy` to force)");
    } else {
        println!("(resolver disabled: skills not distributed; enable plugin `skill-resolver` to turn on)");
    }
}
