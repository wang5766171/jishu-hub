use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PiRuntimeSource {
    BinEnv,
    NodeModule,
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

    // 4. PATH — Node.js Pi agent installed globally via npm
    //    (`@jishu-hub/jishu-agent`). The npm `jishu` bin is a batch/posix shim
    //    that must be invoked via `cmd /C`, which relays the `--mode rpc`
    //    JSON-line stream through an extra cmd.exe layer and breaks the
    //    stdin/stdout handshake (the GUI then hangs forever on "thinking...").
    //    So instead of running the shim, resolve the package's `dist/cli.js`
    //    that npm installs next to it and launch `node` directly — the same
    //    clean-pipe launch the embedded bundle uses (step 3) — so Lite launches
    //    the agent identically to Full. If the `jishu` on PATH is NOT the npm
    //    agent (e.g. a stray pre-rename `jishu.exe` Rust binary, with no
    //    adjacent npm package), the `cli.js` check fails and we fall through to
    //    the error below instead of executing the wrong binary.
    if let Some(shim) = path_lookup("jishu") {
        let cli = shim.parent().map(|dir| {
            dir.join("node_modules")
                .join("@jishu-hub")
                .join("jishu-agent")
                .join("dist")
                .join("cli.js")
        });
        if let Some(cli) = cli.filter(|c| file_exists(c)) {
            let node_bin = path_lookup("node").unwrap_or_else(|| PathBuf::from("node"));
            return Ok(PiRuntimeCommand {
                program: node_bin,
                base_args: vec![cli.to_string_lossy().to_string()],
                source: PiRuntimeSource::NodeModule,
            });
        }
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
