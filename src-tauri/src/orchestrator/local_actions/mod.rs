use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::orchestrator::domain::graph::{ExecutablePayload, VerifyCheck};
use crate::orchestrator::domain::policy::{ApprovalPolicy, NodePolicy};
use crate::orchestrator::domain::run::{AttemptError, ErrorCategory};

const DEFAULT_READ_LIMIT: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct LocalActionOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

pub async fn execute_local_action(
    payload: &ExecutablePayload,
    project_root: &Path,
    policy: &NodePolicy,
) -> Result<LocalActionOutput, AttemptError> {
    match payload {
        ExecutablePayload::Shell {
            command,
            cwd,
            timeout_ms,
        } => {
            require_permission(
                policy.permission_scope.can_run_commands,
                "command execution",
            )?;
            require_no_approval(policy, "command execution")?;
            let cwd = resolve_directory(project_root, cwd.as_deref().unwrap_or(project_root))?;
            let output = crate::os_adapter::shell::run_shell_command(
                command,
                Some(&cwd),
                timeout_ms.or(policy.timeout_ms),
            )
            .await
            .map_err(|message| attempt_error(ErrorCategory::Transient, &message, true))?;
            Ok(LocalActionOutput {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: output.exit_code,
            })
        }
        ExecutablePayload::Read { path, max_bytes } => {
            require_permission(policy.permission_scope.can_read_files, "file read")?;
            let path = resolve_existing_path(project_root, path)?;
            let limit = max_bytes.unwrap_or(DEFAULT_READ_LIMIT);
            let content = tokio::task::spawn_blocking(move || read_limited(&path, limit))
                .await
                .map_err(|error| {
                    attempt_error(
                        ErrorCategory::Transient,
                        &format!("file read task failed: {error}"),
                        true,
                    )
                })?
                .map_err(|message| attempt_error(ErrorCategory::Deterministic, &message, false))?;
            Ok(LocalActionOutput {
                stdout: content,
                stderr: String::new(),
                exit_code: Some(0),
            })
        }
        ExecutablePayload::Write {
            path,
            content,
            requires_approval,
        } => {
            require_permission(policy.permission_scope.can_write_files, "file write")?;
            if *requires_approval {
                return Err(attempt_error(
                    ErrorCategory::Policy,
                    "file write requires approval",
                    false,
                ));
            }
            require_no_approval(policy, "file write")?;
            let path = resolve_write_path(project_root, path)?;
            let content = content.clone();
            tokio::task::spawn_blocking(move || std::fs::write(&path, content))
                .await
                .map_err(|error| {
                    attempt_error(
                        ErrorCategory::Transient,
                        &format!("file write task failed: {error}"),
                        true,
                    )
                })?
                .map_err(|error| {
                    attempt_error(
                        ErrorCategory::Deterministic,
                        &format!("failed to write file: {error}"),
                        false,
                    )
                })?;
            Ok(LocalActionOutput {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: Some(0),
            })
        }
        ExecutablePayload::Verify { check } => execute_verify(check, project_root, policy).await,
        ExecutablePayload::Dispatch { .. } | ExecutablePayload::Reflect { .. } => {
            Err(attempt_error(
                ErrorCategory::Deterministic,
                "payload requires AgentRuntime",
                false,
            ))
        }
    }
}

async fn execute_verify(
    check: &VerifyCheck,
    project_root: &Path,
    policy: &NodePolicy,
) -> Result<LocalActionOutput, AttemptError> {
    match check {
        VerifyCheck::FileExists { path } => {
            require_permission(policy.permission_scope.can_read_files, "file verification")?;
            resolve_existing_path(project_root, path)?;
            Ok(LocalActionOutput {
                stdout: "file exists".into(),
                stderr: String::new(),
                exit_code: Some(0),
            })
        }
        VerifyCheck::CommandSuccess { command, cwd } => {
            execute_command_check(command, cwd.as_deref(), None, project_root, policy).await
        }
        VerifyCheck::OutputContains {
            command,
            cwd,
            substring,
        } => {
            execute_command_check(
                command,
                cwd.as_deref(),
                Some(substring),
                project_root,
                policy,
            )
            .await
        }
    }
}

async fn execute_command_check(
    command: &str,
    cwd: Option<&Path>,
    expected_output: Option<&str>,
    project_root: &Path,
    policy: &NodePolicy,
) -> Result<LocalActionOutput, AttemptError> {
    require_permission(
        policy.permission_scope.can_run_commands,
        "command verification",
    )?;
    require_no_approval(policy, "command verification")?;
    let cwd = resolve_directory(project_root, cwd.unwrap_or(project_root))?;
    let output =
        crate::os_adapter::shell::run_shell_command(command, Some(&cwd), policy.timeout_ms)
            .await
            .map_err(|message| attempt_error(ErrorCategory::Transient, &message, true))?;
    if output.exit_code != Some(0) {
        return Err(attempt_error(
            ErrorCategory::Deterministic,
            &format!("verification command exited with {:?}", output.exit_code),
            false,
        ));
    }
    if let Some(expected_output) = expected_output {
        if !output.stdout.contains(expected_output) {
            return Err(attempt_error(
                ErrorCategory::Deterministic,
                "verification output did not contain the expected text",
                false,
            ));
        }
    }
    Ok(LocalActionOutput {
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code: output.exit_code,
    })
}

fn require_permission(allowed: bool, action: &str) -> Result<(), AttemptError> {
    if allowed {
        Ok(())
    } else {
        Err(attempt_error(
            ErrorCategory::Policy,
            &format!("node policy does not allow {action}"),
            false,
        ))
    }
}

fn require_no_approval(policy: &NodePolicy, action: &str) -> Result<(), AttemptError> {
    if matches!(policy.approval_policy, ApprovalPolicy::Never) {
        Ok(())
    } else {
        Err(attempt_error(
            ErrorCategory::Policy,
            &format!("{action} requires an approval workflow"),
            false,
        ))
    }
}

fn resolve_existing_path(project_root: &Path, requested: &Path) -> Result<PathBuf, AttemptError> {
    let root = canonical_project_root(project_root)?;
    let candidate = candidate_path(&root, requested)?;
    let canonical = candidate.canonicalize().map_err(|error| {
        attempt_error(
            ErrorCategory::Deterministic,
            &format!("path does not exist: {} ({error})", candidate.display()),
            false,
        )
    })?;
    ensure_within_root(&root, &canonical)?;
    Ok(canonical)
}

fn resolve_directory(project_root: &Path, requested: &Path) -> Result<PathBuf, AttemptError> {
    let path = resolve_existing_path(project_root, requested)?;
    if !path.is_dir() {
        return Err(attempt_error(
            ErrorCategory::Policy,
            &format!("working directory is not a directory: {}", path.display()),
            false,
        ));
    }
    Ok(path)
}

fn resolve_write_path(project_root: &Path, requested: &Path) -> Result<PathBuf, AttemptError> {
    let root = canonical_project_root(project_root)?;
    let candidate = candidate_path(&root, requested)?;
    if candidate.exists() {
        let canonical = candidate.canonicalize().map_err(|error| {
            attempt_error(
                ErrorCategory::Deterministic,
                &format!("failed to resolve write path: {error}"),
                false,
            )
        })?;
        ensure_within_root(&root, &canonical)?;
        return Ok(canonical);
    }
    let parent = candidate.parent().ok_or_else(|| {
        attempt_error(
            ErrorCategory::Policy,
            "write path has no parent directory",
            false,
        )
    })?;
    let parent = parent.canonicalize().map_err(|error| {
        attempt_error(
            ErrorCategory::Deterministic,
            &format!(
                "write parent does not exist: {} ({error})",
                parent.display()
            ),
            false,
        )
    })?;
    ensure_within_root(&root, &parent)?;
    let file_name = candidate.file_name().ok_or_else(|| {
        attempt_error(ErrorCategory::Policy, "write path has no file name", false)
    })?;
    Ok(parent.join(file_name))
}

fn canonical_project_root(project_root: &Path) -> Result<PathBuf, AttemptError> {
    project_root.canonicalize().map_err(|error| {
        attempt_error(
            ErrorCategory::Policy,
            &format!(
                "project root does not exist: {} ({error})",
                project_root.display()
            ),
            false,
        )
    })
}

fn candidate_path(root: &Path, requested: &Path) -> Result<PathBuf, AttemptError> {
    if requested.is_absolute() {
        return Ok(requested.to_path_buf());
    }
    if requested.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(attempt_error(
            ErrorCategory::Policy,
            "relative path escapes the project root",
            false,
        ));
    }
    Ok(root.join(requested))
}

fn ensure_within_root(root: &Path, candidate: &Path) -> Result<(), AttemptError> {
    if candidate.starts_with(root) {
        Ok(())
    } else {
        Err(attempt_error(
            ErrorCategory::Policy,
            &format!("path escapes project root: {}", candidate.display()),
            false,
        ))
    }
}

fn read_limited(path: &Path, max_bytes: u64) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("failed to open file: {error}"))?;
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read file: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("file exceeds read limit of {max_bytes} bytes"));
    }
    String::from_utf8(bytes).map_err(|error| format!("file is not valid UTF-8: {error}"))
}

fn attempt_error(category: ErrorCategory, message: &str, retryable: bool) -> AttemptError {
    AttemptError {
        category,
        message: message.into(),
        retryable,
        retry_after_ms: None,
        provider_detail: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn read_rejects_path_escape() {
        let root = tempdir().unwrap();
        let mut policy = NodePolicy::default();
        policy.permission_scope.can_read_files = true;
        let result = execute_local_action(
            &ExecutablePayload::Read {
                path: PathBuf::from("../outside.txt"),
                max_bytes: None,
            },
            root.path(),
            &policy,
        )
        .await;
        assert!(matches!(
            result,
            Err(AttemptError {
                category: ErrorCategory::Policy,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn write_and_read_stay_inside_project_root() {
        let root = tempdir().unwrap();
        let mut policy = NodePolicy::default();
        policy.permission_scope.can_write_files = true;
        policy.permission_scope.can_read_files = true;
        policy.approval_policy = ApprovalPolicy::Never;
        execute_local_action(
            &ExecutablePayload::Write {
                path: PathBuf::from("output.txt"),
                content: "hello".into(),
                requires_approval: false,
            },
            root.path(),
            &policy,
        )
        .await
        .unwrap();
        let output = execute_local_action(
            &ExecutablePayload::Read {
                path: PathBuf::from("output.txt"),
                max_bytes: Some(100),
            },
            root.path(),
            &policy,
        )
        .await
        .unwrap();
        assert_eq!(output.stdout, "hello");
    }
}
