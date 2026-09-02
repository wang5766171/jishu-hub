//! `jishu-cli memory`（v0.8.1 需求8 P1）：项目记忆 KV 的 CLI 读写入口。
//!
//! 消费者：工具插件脚本与智能体（工具插件的 notes 可教智能体用
//! `jishu-cli memory set/get` 持久化项目级信息）；与 GUI 命令
//! （commands/memory.rs）共享 memory_store 同一落盘（~/.jishu-hub/memory.db）。
//! P2 将经 hub MCP server 以 resource 形式二次暴露。

use crate::cli::args::MemoryAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;
use crate::memory_store;

pub fn run(action: MemoryAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        MemoryAction::Set { project, key, value } => {
            let project = normalize_project(&project)?;
            memory_store::set(&project, &key, &value)
                .map_err(|e| CliError::Internal(format!("memory set: {e}")))?;
            if ctx.json {
                println!(
                    "{}",
                    serde_json::json!({"project": project, "key": key, "set": true})
                );
            } else {
                println!("Set {key} for {project}");
            }
            Ok(())
        }
        MemoryAction::Get { project, key } => {
            let project = normalize_project(&project)?;
            let value = memory_store::get(&project, &key)
                .map_err(|e| CliError::Internal(format!("memory get: {e}")))?;
            if ctx.json {
                println!(
                    "{}",
                    serde_json::json!({"project": project, "key": key, "value": value})
                );
            } else {
                match value {
                    Some(v) => println!("{v}"),
                    None => println!("(not set)"),
                }
            }
            Ok(())
        }
        MemoryAction::List { project } => {
            let project = normalize_project(&project)?;
            let entries = memory_store::list(&project)
                .map_err(|e| CliError::Internal(format!("memory list: {e}")))?;
            if ctx.json {
                for e in entries {
                    println!(
                        "{}",
                        serde_json::json!({"key": e.key, "value": e.value, "updated_at": e.updated_at})
                    );
                }
            } else {
                for e in entries {
                    println!("{:<24} {}", e.key, e.value);
                }
            }
            Ok(())
        }
        MemoryAction::Delete { project, key } => {
            let project = normalize_project(&project)?;
            memory_store::delete(&project, &key)
                .map_err(|e| CliError::Internal(format!("memory delete: {e}")))?;
            if ctx.json {
                println!(
                    "{}",
                    serde_json::json!({"project": project, "key": key, "deleted": true})
                );
            } else {
                println!("Deleted {key} for {project}");
            }
            Ok(())
        }
    }
}

/// 相对路径（"." 等）规范化为绝对路径——memory.db 以绝对路径为键，
/// 相对键会让同一项目在不同 cwd 下产生两份记忆。
fn normalize_project(project: &str) -> Result<String, CliError> {
    let path = std::path::Path::new(project);
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| CliError::InvalidArg(format!("cannot resolve cwd: {e}")))?
            .join(path)
    };
    match abs.canonicalize() {
        Ok(p) => Ok(p.to_string_lossy().to_string()),
        Err(_) => Ok(abs.to_string_lossy().to_string()),
    }
}
