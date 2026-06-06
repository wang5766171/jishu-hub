use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PiRuntimeSource {
    CliJsEnv,
    RootEnv,
    BinEnv,
    WorkspaceSubmodule,
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
    if let Some(path) = env_path(env, "JISHU_PI_CLI_JS") {
        return js_runtime(path, PiRuntimeSource::CliJsEnv, &file_exists);
    }

    if let Some(root) = env_path(env, "JISHU_PI_ROOT") {
        let cli = pi_cli_js_from_root(&root);
        return js_runtime(cli, PiRuntimeSource::RootEnv, &file_exists);
    }

    if let Some(path) = env_path(env, "JISHU_PI_BIN") {
        if file_exists(&path) {
            return Ok(PiRuntimeCommand {
                program: path,
                base_args: Vec::new(),
                source: PiRuntimeSource::BinEnv,
            });
        }
        return Err(format!(
            "JISHU_PI_BIN points to a missing Pi executable: {}",
            path.display()
        ));
    }

    let workspace_cli = workspace_pi_cli_js();
    if file_exists(&workspace_cli) {
        return js_runtime(
            workspace_cli,
            PiRuntimeSource::WorkspaceSubmodule,
            &file_exists,
        );
    }

    if let Some(path) = path_lookup("pi") {
        return Ok(PiRuntimeCommand {
            program: path,
            base_args: Vec::new(),
            source: PiRuntimeSource::Path,
        });
    }

    Err("Cannot find Pi runtime. Set JISHU_PI_CLI_JS to packages/coding-agent/dist/cli.js, set JISHU_PI_ROOT to the Pi repo, set JISHU_PI_BIN to a Pi executable, or put pi on PATH.".to_string())
}

pub(crate) fn build_pi_process_args(
    session_dir: &Path,
    session_id: Option<&str>,
    model_args: &[String],
    message: &str,
) -> Vec<String> {
    let mut args = vec![
        "--mode".to_string(),
        "json".to_string(),
        "--session-dir".to_string(),
        session_dir.to_string_lossy().to_string(),
    ];

    if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
        args.push("--session-id".to_string());
        args.push(session_id.to_string());
    }

    args.extend(model_args.iter().cloned());
    args.push(message.to_string());
    args
}

fn env_path(env: &HashMap<String, String>, key: &str) -> Option<PathBuf> {
    env.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn js_runtime<G>(
    cli_js: PathBuf,
    source: PiRuntimeSource,
    file_exists: &G,
) -> Result<PiRuntimeCommand, String>
where
    G: Fn(&Path) -> bool,
{
    if !file_exists(&cli_js) {
        return Err(format!("Pi CLI JS does not exist: {}", cli_js.display()));
    }

    Ok(PiRuntimeCommand {
        program: PathBuf::from("node"),
        base_args: vec![cli_js.to_string_lossy().to_string()],
        source,
    })
}

fn pi_cli_js_from_root(root: &Path) -> PathBuf {
    root.join("packages")
        .join("coding-agent")
        .join("dist")
        .join("cli.js")
}

fn workspace_pi_cli_js() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("third_party")
        .join("pi")
        .join("packages")
        .join("coding-agent")
        .join("dist")
        .join("cli.js")
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

#[cfg(test)]
mod tests {
    use super::*;

    fn map(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    fn exists(paths: &[PathBuf]) -> impl Fn(&Path) -> bool + '_ {
        move |candidate| paths.iter().any(|path| path == candidate)
    }

    #[test]
    fn resolves_cli_js_env_to_node_command() {
        let cli = PathBuf::from(r"D:\pi\packages\coding-agent\dist\cli.js");
        let env = map(&[("JISHU_PI_CLI_JS", &cli.to_string_lossy())]);

        let runtime = resolve_pi_runtime_with(&env, |_| None, exists(&[cli.clone()])).unwrap();

        assert_eq!(runtime.program, PathBuf::from("node"));
        assert_eq!(runtime.base_args, vec![cli.to_string_lossy().to_string()]);
        assert_eq!(runtime.source, PiRuntimeSource::CliJsEnv);
    }

    #[test]
    fn resolves_root_env_to_dist_cli() {
        let root = PathBuf::from(r"D:\pi");
        let cli = root
            .join("packages")
            .join("coding-agent")
            .join("dist")
            .join("cli.js");
        let env = map(&[("JISHU_PI_ROOT", &root.to_string_lossy())]);

        let runtime = resolve_pi_runtime_with(&env, |_| None, exists(&[cli.clone()])).unwrap();

        assert_eq!(runtime.program, PathBuf::from("node"));
        assert_eq!(runtime.base_args, vec![cli.to_string_lossy().to_string()]);
        assert_eq!(runtime.source, PiRuntimeSource::RootEnv);
    }

    #[test]
    fn resolves_bin_env_to_executable() {
        let bin = PathBuf::from(r"D:\Tools\pi.exe");
        let env = map(&[("JISHU_PI_BIN", &bin.to_string_lossy())]);

        let runtime = resolve_pi_runtime_with(&env, |_| None, exists(&[bin.clone()])).unwrap();

        assert_eq!(runtime.program, bin);
        assert!(runtime.base_args.is_empty());
        assert_eq!(runtime.source, PiRuntimeSource::BinEnv);
    }

    #[test]
    fn falls_back_to_path_lookup() {
        let bin = PathBuf::from(r"D:\Tools\pi.exe");
        let runtime =
            resolve_pi_runtime_with(&HashMap::new(), |_| Some(bin.clone()), |_| false).unwrap();

        assert_eq!(runtime.program, bin);
        assert!(runtime.base_args.is_empty());
        assert_eq!(runtime.source, PiRuntimeSource::Path);
    }

    #[test]
    fn missing_runtime_reports_actionable_error() {
        let err = resolve_pi_runtime_with(&HashMap::new(), |_| None, |_| false).unwrap_err();

        assert!(err.contains("JISHU_PI_ROOT"));
        assert!(err.contains("JISHU_PI_CLI_JS"));
        assert!(err.contains("JISHU_PI_BIN"));
        assert!(err.contains("PATH"));
    }

    #[test]
    fn builds_json_mode_process_args() {
        let model_args = vec![
            "--provider".to_string(),
            "anthropic".to_string(),
            "--model".to_string(),
            "claude-sonnet-4-5".to_string(),
        ];
        let args = build_pi_process_args(
            Path::new(r"D:\sessions"),
            Some("sid-1"),
            &model_args,
            "implement it",
        );

        assert_eq!(
            args,
            vec![
                "--mode",
                "json",
                "--session-dir",
                r"D:\sessions",
                "--session-id",
                "sid-1",
                "--provider",
                "anthropic",
                "--model",
                "claude-sonnet-4-5",
                "implement it",
            ]
        );
    }

    /// Confirms dev / unpackaged users don't need to set any of the
    /// `JISHU_PI_*` env vars: the resolver falls back to
    /// `<manifest_dir>/../../third_party/pi/packages/coding-agent/dist/cli.js`,
    /// which is the path the bundled submodule builds into. We pass the
    /// real file_exists closure to exercise the actual on-disk file
    /// (CARGO_MANIFEST_DIR + the path above) and skip the test if the
    /// submodule hasn't been built yet — that's a legitimate "Pi not
    /// available" condition, not a regression.
    #[test]
    fn workspace_submodule_fallback_works_in_repo_checkout() {
        use std::path::PathBuf;
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let cli = manifest
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("third_party")
            .join("pi")
            .join("packages")
            .join("coding-agent")
            .join("dist")
            .join("cli.js");
        if !cli.exists() {
            eprintln!(
                "skipping: {} does not exist (Pi submodule not built in this checkout)",
                cli.display()
            );
            return;
        }
        let runtime = resolve_pi_runtime_with(&HashMap::new(), |_| None, |p| p.exists()).unwrap();
        assert_eq!(runtime.source, PiRuntimeSource::WorkspaceSubmodule);
        assert_eq!(runtime.program, PathBuf::from("node"));
        assert_eq!(runtime.base_args, vec![cli.to_string_lossy().to_string()]);
    }
}
