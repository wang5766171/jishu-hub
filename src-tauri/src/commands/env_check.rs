#[tauri::command]
pub(crate) fn check_prerequisite(command: String) -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut lookup = std::process::Command::new("where");
        crate::process_command::std_no_window(lookup.arg(&command))
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut lookup = std::process::Command::new("which");
        lookup
            .arg(&command)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

#[derive(serde::Serialize)]
pub struct EnvStatus {
    pub node_installed: bool,
    pub node_version: Option<String>,
    pub npm_installed: bool,
    pub npm_version: Option<String>,
    pub python_installed: bool,
    pub python_version: Option<String>,
    pub git_installed: bool,
    pub git_version: Option<String>,
    pub runtimes: Vec<RuntimeStatus>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RuntimeStatus {
    pub id: String,
    pub installed: bool,
    pub version: Option<String>,
    pub install_command: Option<String>,
    pub update_command: Option<String>,
    pub download_url: Option<String>,
    pub latest_package: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum RuntimeLatestSource {
    Npm { package: &'static str },
    Python,
    GitForWindows,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RuntimeDefinition {
    pub(crate) id: &'static str,
    pub(crate) program: &'static str,
    pub(crate) version_args: &'static [&'static str],
    pub(crate) version_prefixes: &'static [&'static str],
    pub(crate) install_command: Option<&'static str>,
    pub(crate) update_command: Option<&'static str>,
    pub(crate) download_url: Option<&'static str>,
    pub(crate) latest: Option<RuntimeLatestSource>,
}

const RUNTIME_REGISTRY: &[RuntimeDefinition] = &[
    RuntimeDefinition {
        id: "node",
        program: "node",
        version_args: &["--version"],
        version_prefixes: &["v"],
        install_command: None,
        update_command: None,
        download_url: Some("https://nodejs.org/"),
        latest: Some(RuntimeLatestSource::Npm { package: "node" }),
    },
    RuntimeDefinition {
        id: "npm",
        program: "npm",
        version_args: &["--version"],
        version_prefixes: &[],
        install_command: None,
        update_command: Some("npm install -g npm@latest"),
        download_url: None,
        latest: Some(RuntimeLatestSource::Npm { package: "npm" }),
    },
    RuntimeDefinition {
        id: "python",
        program: "python",
        version_args: &["--version"],
        version_prefixes: &["Python "],
        install_command: None,
        update_command: None,
        download_url: Some("https://www.python.org/downloads/"),
        latest: Some(RuntimeLatestSource::Python),
    },
    RuntimeDefinition {
        id: "git",
        program: "git",
        version_args: &["--version"],
        version_prefixes: &["git version "],
        install_command: crate::os_adapter::package_manager::get_git_install_command(),
        update_command: crate::os_adapter::package_manager::get_git_update_command(),
        download_url: crate::os_adapter::package_manager::get_git_download_url(),
        latest: Some(RuntimeLatestSource::GitForWindows),
    },
];

pub(crate) fn runtime_registry() -> &'static [RuntimeDefinition] {
    RUNTIME_REGISTRY
}

/// Build a platform-aware command. On Windows, .cmd/.bat scripts (npm, npx, etc.)
/// must be invoked via `cmd /C <command>` since `Command::new("npm")` won't resolve
/// npm.cmd. On Unix, invoke the binary directly.
pub(crate) fn shell_command(program: &str, args: Vec<String>) -> tokio::process::Command {
    crate::os_adapter::shell::shell_command(program, args)
}

fn normalize_version_output(stdout: &[u8], stderr: &[u8], prefixes: &[&str]) -> Option<String> {
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    let raw = if stdout.is_empty() { stderr } else { stdout };
    let mut version = raw.trim().to_string();
    for prefix in prefixes {
        if let Some(rest) = version.strip_prefix(prefix) {
            version = rest.trim().to_string();
            break;
        }
    }
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

async fn check_runtime(definition: &RuntimeDefinition) -> RuntimeStatus {
    let args = definition
        .version_args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    let output =
        crate::process_command::tokio_no_window(&mut shell_command(definition.program, args))
            .output()
            .await;
    let (installed, version) = match output {
        Ok(out) if out.status.success() => (
            true,
            normalize_version_output(&out.stdout, &out.stderr, definition.version_prefixes),
        ),
        _ => (false, None),
    };
    RuntimeStatus {
        id: definition.id.to_string(),
        installed,
        version,
        install_command: definition.install_command.map(str::to_string),
        update_command: definition.update_command.map(str::to_string),
        download_url: definition.download_url.map(str::to_string),
        latest_package: runtime_latest_package(definition).map(str::to_string),
    }
}

pub(crate) fn runtime_latest_package(definition: &RuntimeDefinition) -> Option<&'static str> {
    match definition.latest {
        Some(RuntimeLatestSource::Npm { package }) => Some(package),
        Some(RuntimeLatestSource::Python) => Some("python"),
        Some(RuntimeLatestSource::GitForWindows) => Some("git"),
        None => None,
    }
}

fn runtime_status<'a>(runtimes: &'a [RuntimeStatus], id: &str) -> Option<&'a RuntimeStatus> {
    runtimes.iter().find(|runtime| runtime.id == id)
}

#[tauri::command]
pub(crate) async fn check_environment() -> Result<EnvStatus, String> {
    // Probe all runtimes concurrently: each `check_runtime` spawns a child
    // process (`--version`), and serialising them adds up. Running them in
    // parallel collapses N sequential round-trips into one.
    let runtimes: Vec<RuntimeStatus> =
        futures_util::future::join_all(runtime_registry().iter().map(check_runtime)).await;
    let node = runtime_status(&runtimes, "node");
    let npm = runtime_status(&runtimes, "npm");
    let python = runtime_status(&runtimes, "python");
    let git = runtime_status(&runtimes, "git");

    Ok(EnvStatus {
        node_installed: node.is_some_and(|runtime| runtime.installed),
        node_version: node.and_then(|runtime| runtime.version.clone()),
        npm_installed: npm.is_some_and(|runtime| runtime.installed),
        npm_version: npm.and_then(|runtime| runtime.version.clone()),
        python_installed: python.is_some_and(|runtime| runtime.installed),
        python_version: python.and_then(|runtime| runtime.version.clone()),
        git_installed: git.is_some_and(|runtime| runtime.installed),
        git_version: git.and_then(|runtime| runtime.version.clone()),
        runtimes,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn normalizes_runtime_version_outputs() {
        assert_eq!(
            super::normalize_version_output(b"Python 3.12.4\r\n", b"", &["Python "]),
            Some("3.12.4".to_string())
        );
        assert_eq!(
            super::normalize_version_output(
                b"git version 2.50.1.windows.1\n",
                b"",
                &["git version "]
            ),
            Some("2.50.1.windows.1".to_string())
        );
    }
}
