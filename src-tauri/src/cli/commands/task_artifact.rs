//! `jishu-cli task lock-requirement / commit-plan`（v0.8.1 需求10）：
//! 自适应插件的 CLI 形态底层——任何 agent 经 prompt 注入调 CLI 产出
//! 结构化需求/计划文档，落盘到与 conductor 完全一致的
//! `.jishu-hub/tasks/<id>/artifacts/` 目录（产物格式统一）。

use crate::cli::args::TaskArtifactAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run_task_artifact(
    action: TaskArtifactAction,
    ctx: &ExecutionContext,
) -> Result<(), CliError> {
    match action {
        TaskArtifactAction::LockRequirement {
            title,
            goal,
            scope,
            acceptance,
            project,
            task_id,
        } => lock_requirement(&title, &goal, &scope, &acceptance, &project, task_id, ctx),
        TaskArtifactAction::CommitPlan {
            nodes,
            project,
            task_id,
        } => commit_plan(&nodes, &project, task_id, ctx),
    }
}

fn sha256_hex(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let result = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in result {
        use std::fmt::Write;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// 任务产物根目录（与 conductor 的 task_workspace_root 一致）。
fn tasks_root(project: &str) -> std::path::PathBuf {
    std::path::Path::new(project)
        .join(".jishu-hub")
        .join("tasks")
}

fn lock_requirement(
    title: &str,
    goal: &str,
    scope: &str,
    acceptance: &str,
    project: &str,
    task_id: Option<String>,
    ctx: &ExecutionContext,
) -> Result<(), CliError> {
    let id = task_id.unwrap_or_else(|| format!("free-{}", chrono::Utc::now().timestamp()));
    let dir = tasks_root(project)
        .join(&id)
        .join("artifacts")
        .join("requirements");
    std::fs::create_dir_all(&dir).map_err(|e| CliError::Internal(format!("create dir: {e}")))?;

    // REQUIREMENTS.md（与 conductor renderRequirement 模板同构）
    let md = format!(
        "# {title}\n\n## 目标\n{goal}\n\n## 范围\n{}\n\n## 验收标准\n{}\n",
        scope
            .split(';')
            .map(|s| format!("- {}", s.trim()))
            .collect::<Vec<_>>()
            .join("\n"),
        acceptance
            .split(';')
            .map(|s| format!("- {}", s.trim()))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let hash = sha256_hex(&md);
    std::fs::write(dir.join("REQUIREMENTS.md"), &md)
        .map_err(|e| CliError::Internal(format!("write REQUIREMENTS.md: {e}")))?;

    let manifest = serde_json::json!({
        "artifact_id": "requirements",
        "schema_version": "jishu-requirements/v1",
        "content_hash": format!("sha256:{hash}"),
        "generated_phase": "discuss",
        "task_id": id,
    });
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .map_err(|e| CliError::Internal(format!("write manifest: {e}")))?;

    let out = dir.join("REQUIREMENTS.md");
    if ctx.json {
        println!(
            "{}",
            serde_json::json!({ "task_id": id, "path": out.to_string_lossy() })
        );
    } else {
        println!("Requirements written: {}", out.display());
    }
    Ok(())
}

fn commit_plan(
    nodes_json: &str,
    project: &str,
    task_id: Option<String>,
    ctx: &ExecutionContext,
) -> Result<(), CliError> {
    let nodes: serde_json::Value = serde_json::from_str(nodes_json)
        .map_err(|e| CliError::InvalidArg(format!("invalid nodes JSON: {e}")))?;
    let id = task_id.unwrap_or_else(|| format!("free-{}", chrono::Utc::now().timestamp()));
    let dir = tasks_root(project)
        .join(&id)
        .join("artifacts")
        .join("planning");
    std::fs::create_dir_all(&dir).map_err(|e| CliError::Internal(format!("create dir: {e}")))?;

    let plan = serde_json::json!({
        "schema": "jishu-flow-plan-proposal/v1",
        "nodes": nodes,
    });
    let json_str = serde_json::to_string_pretty(&plan).unwrap();
    let hash = sha256_hex(&json_str);
    std::fs::write(dir.join("flow-plan-proposal.json"), &json_str)
        .map_err(|e| CliError::Internal(format!("write plan: {e}")))?;

    let manifest = serde_json::json!({
        "artifact_id": "planning",
        "schema_version": "jishu-flow-plan-proposal/v1",
        "content_hash": format!("sha256:{hash}"),
        "generated_phase": "plan",
        "task_id": id,
    });
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .map_err(|e| CliError::Internal(format!("write manifest: {e}")))?;

    let out = dir.join("flow-plan-proposal.json");
    if ctx.json {
        println!(
            "{}",
            serde_json::json!({ "task_id": id, "path": out.to_string_lossy() })
        );
    } else {
        println!("Plan written: {}", out.display());
    }
    Ok(())
}
