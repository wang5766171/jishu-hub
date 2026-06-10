use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PiRuntimeSource {
    BinEnv,
    NodeModule,
    Path,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PiRuntimeCommand {
    pub(crate) program: PathBuf,
    pub(crate) base_args: Vec<String>,
    pub(crate) source: PiRuntimeSource,
}

pub(crate) fn resolve_pi_runtime() -> Result<PiRuntimeCommand, String> {
    let env: HashMap<String, String> = std::env::vars().collect();
    resolve_pi_runtime_with(&env, find_on_path, |path| path.exists())
}

pub(crate) fn resolve_pi_runtime_with<F, G>(
    env: &HashMap<String, String>,
    path_lookup: F,
    file_exists: G,
) -> Result<PiRuntimeCommand, String>
where
    F: Fn(&str) -> Option<PathBuf>,
    G: Fn(&Path) -> bool,
{
    // 1. Env override for binary
    if let Some(path) = env_path(env, "JISHU_PI_BIN") {
        if file_exists(&path) {
            return Ok(PiRuntimeCommand {
                program: path,
                base_args: Vec::new(),
                source: PiRuntimeSource::BinEnv,
            });
        }
        return Err(format!(
            "JISHU_PI_BIN points to a missing executable: {}",
            path.display()
        ));
    }

    // 2. User-installed Node Module (from UI updates)
    if let Some(agent_dir) = crate::agent::jishu_self::pi_agent_dir() {
        let entry = PathBuf::from(&agent_dir)
            .join("packages")
            .join("coding-agent")
            .join("dist")
            .join("cli.js");
        if file_exists(&entry) {
            let mut base_args = vec![entry.to_string_lossy().to_string()];
            let node_bin = path_lookup("node").unwrap_or_else(|| PathBuf::from("node"));
            return Ok(PiRuntimeCommand {
                program: node_bin,
                base_args,
                source: PiRuntimeSource::NodeModule,
            });
        }
    }

    // 3. Embedded Node Module (from Tauri bundle)
    let internal_pi_dir = if let Ok(mut install_dir) = std::env::current_exe() {
        install_dir.pop();
        install_dir.join("third_party").join("pi-bundle")
    } else {
        PathBuf::from("")
    };

    if let Some(agent_dir) = Some(internal_pi_dir) {
        let entry = PathBuf::from(&agent_dir)
            .join("packages")
            .join("coding-agent")
            .join("dist")
            .join("cli.js");
        if file_exists(&entry) {
            let mut base_args = vec![entry.to_string_lossy().to_string()];
            let node_bin = path_lookup("node").unwrap_or_else(|| PathBuf::from("node"));
            return Ok(PiRuntimeCommand {
                program: node_bin,
                base_args,
                source: PiRuntimeSource::NodeModule,
            });
        }
    }


    // 4. PATH
    if let Some(path) = path_lookup("jishu") {
        return Ok(PiRuntimeCommand {
            program: path,
            base_args: Vec::new(),
            source: PiRuntimeSource::Path,
        });
    }

    Err(
        "Cannot find Pi agent. Ensure Jishu Agent is installed or pi submodule is built."
            .to_string(),
    )
}

pub(crate) fn build_pi_interactive_args(
    sessions_root: &Path,
    session_file: Option<&Path>,
    model_args: &[String],
) -> Vec<String> {
    let mut args = vec![
        "--session-dir".to_string(),
        sessions_root.to_string_lossy().to_string(),
    ];

    if let Some(session_file) = session_file {
        args.push("--session".to_string());
        args.push(session_file.to_string_lossy().to_string());
    }

    args.extend(model_args.iter().cloned());
    args
}

fn env_path(env: &HashMap<String, String>, key: &str) -> Option<PathBuf> {
    env.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn find_on_path(bin: &str) -> Option<PathBuf> {
    let path_var: OsString = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }

        #[cfg(windows)]
        {
            let candidate = dir.join(format!("{bin}.exe"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
