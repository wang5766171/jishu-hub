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

/// 分号切分字段非空校验（v0.9.0 需求2：lock-requirement 空项过滤）。
fn split_non_empty(raw: &str) -> Vec<String> {
    raw.split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// 计划节点结构校验（v0.9.0 需求2，评审 P3 补齐）：对照 conductor Step
/// 契约（jishu-task-conductor.ts:23-31）——nodes 为数组、每节点 id/title
/// 非空且 id 唯一、depends_on 引用存在、依赖无环。
fn validate_plan_nodes(nodes: &serde_json::Value) -> Result<(), String> {
    let Some(arr) = nodes.as_array() else {
        return Err("nodes 必须是数组".to_string());
    };
    if arr.is_empty() {
        return Err("nodes 不能为空".to_string());
    }
    let mut ids = std::collections::HashSet::new();
    for (i, node) in arr.iter().enumerate() {
        let id = node
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if id.is_empty() {
            return Err(format!("nodes[{i}].id 不能为空"));
        }
        if !ids.insert(id.to_string()) {
            return Err(format!("nodes[{i}].id 重复：{id}"));
        }
        let title = node
            .get("title")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if title.is_empty() {
            return Err(format!("nodes[{i}].title 不能为空（id={id}）"));
        }
    }
    // depends_on 引用存在性。
    for (i, node) in arr.iter().enumerate() {
        let id = node["id"].as_str().unwrap_or_default();
        if let Some(deps) = node.get("depends_on").and_then(serde_json::Value::as_array) {
            for dep in deps {
                let dep = dep.as_str().unwrap_or_default();
                if !ids.contains(dep) {
                    return Err(format!(
                        "nodes[{i}].depends_on 引用不存在的节点：{dep}（id={id}）"
                    ));
                }
            }
        }
    }
    // 依赖无环（DFS 三色标记）。
    let mut edges = std::collections::HashMap::<&str, Vec<&str>>::new();
    for node in arr {
        let id = node["id"].as_str().unwrap_or_default();
        let deps = node
            .get("depends_on")
            .and_then(serde_json::Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|d| d.as_str())
                    .filter(|d| ids.contains(*d))
                    .collect()
            })
            .unwrap_or_default();
        edges.insert(id, deps);
    }
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        White,
        Gray,
        Black,
    }
    fn dfs<'a>(
        node: &'a str,
        edges: &std::collections::HashMap<&'a str, Vec<&'a str>>,
        marks: &mut std::collections::HashMap<&'a str, Mark>,
    ) -> bool {
        match marks.get(node) {
            Some(Mark::Gray) => return false, // 回边 = 环
            Some(Mark::Black) => return true,
            _ => {}
        }
        marks.insert(node, Mark::Gray);
        if let Some(deps) = edges.get(node) {
            for dep in deps {
                if !dfs(dep, edges, marks) {
                    return false;
                }
            }
        }
        marks.insert(node, Mark::Black);
        true
    }
    let mut marks = std::collections::HashMap::new();
    for node in arr {
        let id = node["id"].as_str().unwrap_or_default();
        if !dfs(id, &edges, &mut marks) {
            return Err(format!("nodes 依赖存在环（含节点 {id}）"));
        }
    }
    Ok(())
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
    // v0.9.0 需求2：空项校验——scope/acceptance 分号切分后须至少一项非空
    //（渲染模板保持与 conductor 同构，仅过滤空段）。
    let scope_items = split_non_empty(scope);
    let acceptance_items = split_non_empty(acceptance);
    if scope_items.is_empty() {
        return Err(CliError::InvalidArg(
            "scope 至少需要一项非空条目（分号分隔）".to_string(),
        ));
    }
    if acceptance_items.is_empty() {
        return Err(CliError::InvalidArg(
            "acceptance 至少需要一项非空条目（分号分隔）".to_string(),
        ));
    }
    let dir = tasks_root(project)
        .join(&id)
        .join("artifacts")
        .join("requirements");
    std::fs::create_dir_all(&dir).map_err(|e| CliError::Internal(format!("create dir: {e}")))?;

    // REQUIREMENTS.md（与 conductor renderRequirement 模板同构）
    let md = format!(
        "# {title}\n\n## 目标\n{goal}\n\n## 范围\n{}\n\n## 验收标准\n{}\n",
        scope_items
            .iter()
            .map(|s| format!("- {s}"))
            .collect::<Vec<_>>()
            .join("\n"),
        acceptance_items
            .iter()
            .map(|s| format!("- {s}"))
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
    // v0.9.0 需求2：节点结构校验（必填/唯一/引用/无环）——坏计划在落盘前
    // 拒绝，产物哈希链不接纳非法结构。
    validate_plan_nodes(&nodes).map_err(CliError::InvalidArg)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: &str, title: &str, deps: &[&str]) -> serde_json::Value {
        json!({
            "id": id,
            "title": title,
            "responsibility": "",
            "acceptance": "",
            "depends_on": deps,
            "role": "",
            "status": ""
        })
    }

    #[test]
    fn valid_plan_passes() {
        let nodes = json!([
            node("a", "调研", &[]),
            node("b", "实施", &["a"]),
            node("c", "验证", &["a", "b"]),
        ]);
        assert!(validate_plan_nodes(&nodes).is_ok());
    }

    #[test]
    fn missing_title_or_dupe_id_rejected() {
        let no_title = json!([{ "id": "a", "title": " " }]);
        assert!(validate_plan_nodes(&no_title).is_err());
        let dupe = json!([node("a", "一", &[]), node("a", "二", &[])]);
        assert!(validate_plan_nodes(&dupe).is_err());
        assert!(validate_plan_nodes(&json!([])).is_err());
        assert!(validate_plan_nodes(&json!({})).is_err());
    }

    #[test]
    fn dangling_depends_on_rejected() {
        let nodes = json!([node("a", "一", &["ghost"])]);
        let err = validate_plan_nodes(&nodes).unwrap_err();
        assert!(err.contains("ghost"), "{err}");
    }

    #[test]
    fn dependency_cycle_rejected() {
        let nodes = json!([
            node("a", "一", &["b"]),
            node("b", "二", &["c"]),
            node("c", "三", &["a"]),
        ]);
        assert!(validate_plan_nodes(&nodes).unwrap_err().contains("环"));
    }

    #[test]
    fn split_non_empty_filters() {
        assert_eq!(split_non_empty("a;; b ;"), vec!["a", "b"]);
        assert!(split_non_empty(" ; ;").is_empty());
    }
}
