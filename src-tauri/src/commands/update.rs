use super::env_check::{
    runtime_latest_package, runtime_registry, shell_command, RuntimeDefinition, RuntimeLatestSource,
};

#[derive(serde::Serialize)]
pub struct LatestVersion {
    pub id: String,
    pub latest_version: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub(crate) async fn check_available_updates(packages: Vec<(String, String)>) -> Vec<LatestVersion> {
    // Resolve latest versions concurrently: each query is an `npm view`
    // round-trip (or runtime-specific probe) taking seconds each, so
    // serialising them dominates the refresh latency.
    futures_util::future::join_all(packages.into_iter().map(|(id, pkg)| async move {
        if let Some(version) = pkg.strip_prefix("__managed__:") {
            return LatestVersion {
                id,
                latest_version: Some(version.to_string()),
                error: None,
            };
        }
        if let Some(definition) = runtime_registry().iter().find(|runtime| {
            runtime.id == id || runtime_latest_package(runtime) == Some(pkg.as_str())
        }) {
            return check_runtime_latest(&id, definition).await;
        }

        let mut cmd = shell_command(
            "npm",
            vec![
                "view".into(),
                pkg.clone(),
                "version".into(),
                "--json".into(),
            ],
        );
        let output = crate::process_command::tokio_no_window(&mut cmd)
            .output()
            .await;

        match output {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let version = stdout.trim_matches('"').trim().to_string();
                if !version.is_empty() {
                    LatestVersion {
                        id,
                        latest_version: Some(version),
                        error: None,
                    }
                } else {
                    LatestVersion {
                        id,
                        latest_version: None,
                        error: Some("empty response".into()),
                    }
                }
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                LatestVersion {
                    id,
                    latest_version: None,
                    error: Some(stderr),
                }
            }
            Err(e) => LatestVersion {
                id,
                latest_version: None,
                error: Some(e.to_string()),
            },
        }
    }))
    .await
}

async fn check_runtime_latest(id: &str, definition: &RuntimeDefinition) -> LatestVersion {
    match definition.latest {
        Some(RuntimeLatestSource::Npm { package }) => check_npm_latest(id, package).await,
        Some(RuntimeLatestSource::Python) => check_python_latest(id).await,
        Some(RuntimeLatestSource::GitForWindows) => check_git_latest(id).await,
        None => LatestVersion {
            id: id.to_string(),
            latest_version: None,
            error: Some("runtime has no latest-version source".to_string()),
        },
    }
}

async fn check_npm_latest(id: &str, package: &str) -> LatestVersion {
    let mut cmd = shell_command(
        "npm",
        vec![
            "view".into(),
            package.to_string(),
            "version".into(),
            "--json".into(),
        ],
    );
    let output = crate::process_command::tokio_no_window(&mut cmd)
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let version = stdout.trim_matches('"').trim().to_string();
            if !version.is_empty() {
                LatestVersion {
                    id: id.to_string(),
                    latest_version: Some(version),
                    error: None,
                }
            } else {
                LatestVersion {
                    id: id.to_string(),
                    latest_version: None,
                    error: Some("empty response".into()),
                }
            }
        }
        Ok(out) => LatestVersion {
            id: id.to_string(),
            latest_version: None,
            error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        },
        Err(e) => LatestVersion {
            id: id.to_string(),
            latest_version: None,
            error: Some(e.to_string()),
        },
    }
}

async fn fetch_text_url(url: &str) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "(Invoke-WebRequest -Uri '{}' -UseBasicParsing).Content",
            url
        );
        let mut ps_cmd = tokio::process::Command::new("powershell");
        let output = crate::process_command::tokio_no_window(ps_cmd.args([
            "-NoProfile",
            "-Command",
            &script,
        ]))
        .output()
        .await;
        match output {
            Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).to_string()),
            Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Err(e) => Err(e.to_string()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = tokio::process::Command::new("curl");
        let output = crate::process_command::tokio_no_window(cmd.args([
            "-sfL",
            "-H",
            "User-Agent: jishu-hub",
            url,
        ]))
        .output()
        .await;
        match output {
            Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).to_string()),
            Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Err(e) => Err(e.to_string()),
        }
    }
}

async fn check_python_latest(id: &str) -> LatestVersion {
    let url = "https://endoflife.date/api/python.json";

    let body = match fetch_text_url(url).await {
        Ok(b) => b,
        Err(e) => {
            return LatestVersion {
                id: id.to_string(),
                latest_version: None,
                error: Some(e),
            };
        }
    };

    // Parse JSON array and extract latest version from first entry
    let version = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.as_array()?
                .first()?
                .get("latest")?
                .as_str()
                .map(String::from)
        });

    match version {
        Some(v) => LatestVersion {
            id: id.to_string(),
            latest_version: Some(v),
            error: None,
        },
        None => LatestVersion {
            id: id.to_string(),
            latest_version: None,
            error: Some("could not parse version from API response".into()),
        },
    }
}

async fn check_git_latest(id: &str) -> LatestVersion {
    let url = "https://api.github.com/repos/git-for-windows/git/releases/latest";

    let body = match fetch_text_url(url).await {
        Ok(b) => b,
        Err(e) => {
            return LatestVersion {
                id: id.to_string(),
                latest_version: None,
                error: Some(e),
            };
        }
    };

    let version = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("tag_name")?.as_str().map(String::from))
        .map(|tag| tag.trim_start_matches('v').to_string());

    match version {
        Some(v) if !v.is_empty() => LatestVersion {
            id: id.to_string(),
            latest_version: Some(v),
            error: None,
        },
        _ => LatestVersion {
            id: id.to_string(),
            latest_version: None,
            error: Some("could not parse version from GitHub response".into()),
        },
    }
}

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub release_url: String,
    pub source: String,
    pub error: Option<String>,
}

const GH_API: &str = "https://api.github.com/repos/wang5766171/jishu-hub/releases/latest";
const GH_PAGE: &str = "https://github.com/wang5766171/jishu-hub/releases/latest";
const GITEE_API: &str = "https://gitee.com/api/v5/repos/wangzwa/jishu-hub/releases/latest";
const GITEE_PAGE: &str = "https://gitee.com/wangzwa/jishu-hub/releases/latest";

/// HTTP GET returning the response body. Reuses the existing platform pattern
/// (PowerShell on Windows, curl elsewhere). URLs are fixed constants 鈥?no
/// untrusted interpolation.
async fn http_get_text(url: &str, timeout_secs: u32) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "(Invoke-WebRequest -Uri '{}' -UseBasicParsing -TimeoutSec {}).Content",
            url, timeout_secs
        );
        let mut cmd = tokio::process::Command::new("powershell");
        let output = crate::process_command::tokio_no_window(cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ]))
        .output()
        .await
        .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = tokio::process::Command::new("curl");
        let output = cmd
            .args([
                "-sfL",
                "--max-time",
                &timeout_secs.to_string(),
                "-A",
                "jishu-hub",
                url,
            ])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(format!("request failed: {}", url))
        }
    }
}

/// Detect whether the host is on an overseas network by probing a resource
/// that is reachable abroad but typically blocked/timed-out within mainland CN.
async fn is_overseas_network() -> bool {
    http_get_text("https://www.google.com/generate_204", 3)
        .await
        .is_ok()
}

fn version_parts(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(['.', '-', '+'])
        .map(|p| {
            p.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (version_parts(latest), version_parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

/// Fetch the latest release JSON, picking gitee for CN networks and github
/// abroad, with the other acting as fallback (github is always a fallback).
async fn fetch_latest_release() -> Result<(String, String, serde_json::Value), String> {
    let overseas = is_overseas_network().await;
    let order = if overseas {
        [
            ("github", GH_API, GH_PAGE),
            ("gitee", GITEE_API, GITEE_PAGE),
        ]
    } else {
        [
            ("gitee", GITEE_API, GITEE_PAGE),
            ("github", GH_API, GH_PAGE),
        ]
    };
    let mut last_err = String::from("network unavailable");
    for (source, api, page) in order {
        match http_get_text(api, 8).await {
            Ok(body) => match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) if v.get("tag_name").is_some() => {
                    return Ok((source.to_string(), page.to_string(), v))
                }
                _ => last_err = format!("{}: cannot parse release", source),
            },
            Err(e) => last_err = format!("{}: {}", source, e),
        }
    }
    Err(last_err)
}

/// Check for a newer release (no download). Used by the manual "click version
/// to check" flow in the About panel.
#[tauri::command]
pub(crate) async fn check_for_update() -> UpdateInfo {
    let current = env!("CARGO_PKG_VERSION").to_string();
    match fetch_latest_release().await {
        Ok((source, page, release)) => {
            let tag = release
                .get("tag_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            UpdateInfo {
                has_update: is_newer(&tag, &current),
                latest_version: Some(tag),
                current_version: current,
                release_url: page,
                source,
                error: None,
            }
        }
        Err(e) => UpdateInfo {
            current_version: current,
            latest_version: None,
            has_update: false,
            release_url: GH_PAGE.to_string(),
            source: "github".to_string(),
            error: Some(e),
        },
    }
}

#[derive(serde::Serialize)]
pub struct DownloadResult {
    pub version: Option<String>,
    pub installer_path: Option<String>,
    pub error: Option<String>,
}

/// Whether the installed copy was placed by the MSI installer (vs NSIS).
#[cfg(target_os = "windows")]
async fn installed_via_msi() -> bool {
    let script = "$ErrorActionPreference='SilentlyContinue';\
$p='HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*';\
$e=Get-ItemProperty $p | Where-Object { $_.DisplayName -like '*Jishu Hub*' } | Select-Object -First 1;\
if ($e -and ($e.WindowsInstaller -eq 1 -or $e.UninstallString -match 'msiexec')) { 'msi' } else { 'nsis' }";
    let mut cmd = tokio::process::Command::new("powershell");
    let out = crate::process_command::tokio_no_window(cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ]))
    .output()
    .await;
    matches!(out, Ok(o) if String::from_utf8_lossy(&o.stdout).trim() == "msi")
}

#[cfg(not(target_os = "windows"))]
async fn installed_via_msi() -> bool {
    false
}

/// Pick the installer asset matching the user's install method, defaulting to
/// the NSIS `-setup.exe` package when MSI isn't preferred or can't be matched.
fn pick_installer_asset(release: &serde_json::Value, prefer_msi: bool) -> Option<(String, String)> {
    let assets: Vec<(String, String)> = release
        .get("assets")?
        .as_array()?
        .iter()
        .filter_map(|a| {
            Some((
                a.get("name")?.as_str()?.to_string(),
                a.get("browser_download_url")?.as_str()?.to_string(),
            ))
        })
        .collect();
    let ends = |n: &str, suf: &str| n.to_lowercase().ends_with(suf);
    let x64 = |n: &str| n.to_lowercase().contains("x64");
    let want = if prefer_msi { ".msi" } else { "-setup.exe" };
    assets
        .iter()
        .find(|(n, _)| ends(n, want) && x64(n))
        .or_else(|| assets.iter().find(|(n, _)| ends(n, want)))
        .or_else(|| assets.iter().find(|(n, _)| ends(n, "-setup.exe") && x64(n)))
        .or_else(|| assets.iter().find(|(n, _)| ends(n, "-setup.exe")))
        .cloned()
}

async fn download_to_file(url: &str, dest: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "(New-Object Net.WebClient).DownloadFile('{}','{}')",
            url.replace('\'', "''"),
            dest.to_string_lossy().replace('\'', "''")
        );
        let mut cmd = tokio::process::Command::new("powershell");
        let out = crate::process_command::tokio_no_window(cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ]))
        .output()
        .await
        .map_err(|e| e.to_string())?;
        if out.status.success() && dest.exists() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let out = tokio::process::Command::new("curl")
            .args(["-sfL", "-o", &dest.to_string_lossy(), url])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err("download failed".into())
        }
    }
}

/// Check for a newer release and, if found, download the matching installer.
/// Triggered automatically (async) on app startup.
#[tauri::command]
pub(crate) async fn download_update() -> DownloadResult {
    // v0.7.2 需求 1 / M3.2：24h 冷却，避免每次启动都跑网络探测（google 探测 +
    // gitee/github release + 可能下载安装包）。前端 M3.1 已把调用延后到启动高峰
    // 之后，这里进一步限频。即使本次探测失败也记录冷却，保证启动不被频繁网络请求拖累。
    const UPDATE_CHECK_COOLDOWN_MS: i64 = 24 * 60 * 60 * 1000;
    let now_ms = chrono::Local::now().timestamp_millis();
    if let Some(last) = crate::hub::load_last_update_check() {
        if now_ms - last < UPDATE_CHECK_COOLDOWN_MS {
            return DownloadResult {
                version: None,
                installer_path: None,
                error: None,
            };
        }
    }
    let _ = crate::hub::save_last_update_check(now_ms);

    let current = env!("CARGO_PKG_VERSION").to_string();
    let release = match fetch_latest_release().await {
        Ok((_, _, r)) => r,
        Err(e) => {
            return DownloadResult {
                version: None,
                installer_path: None,
                error: Some(e),
            }
        }
    };
    let tag = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if tag.is_empty() || !is_newer(&tag, &current) {
        return DownloadResult {
            version: None,
            installer_path: None,
            error: None,
        };
    }
    let Some((name, url)) = pick_installer_asset(&release, installed_via_msi().await) else {
        return DownloadResult {
            version: Some(tag),
            installer_path: None,
            error: Some("no matching installer asset".into()),
        };
    };
    let dest = dirs::download_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(&name);
    match download_to_file(&url, &dest).await {
        Ok(()) => DownloadResult {
            version: Some(tag),
            installer_path: Some(dest.to_string_lossy().to_string()),
            error: None,
        },
        Err(e) => DownloadResult {
            version: Some(tag),
            installer_path: None,
            error: Some(e),
        },
    }
}

/// Launch the downloaded installer and quit so it can replace the running app.
#[tauri::command]
pub(crate) fn install_update(app: tauri::AppHandle, installer_path: String) -> Result<(), String> {
    let p = std::path::Path::new(&installer_path);
    let is_installer = p
        .extension()
        .map(|e| e.eq_ignore_ascii_case("exe") || e.eq_ignore_ascii_case("msi"))
        .unwrap_or(false);
    if !is_installer {
        return Err("Invalid installer: not .exe or .msi".to_string());
    }

    let canon_p =
        std::fs::canonicalize(p).map_err(|e| format!("Cannot resolve installer path: {}", e))?;
    if !canon_p.is_file() {
        return Err("Installer file not found".to_string());
    }

    let allowed_dir = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
    let canon_dir = std::fs::canonicalize(&allowed_dir).unwrap_or(allowed_dir);
    let temp_dir = std::env::temp_dir();
    let canon_temp = std::fs::canonicalize(&temp_dir).unwrap_or(temp_dir);

    if !(canon_p.starts_with(&canon_dir) || canon_p.starts_with(&canon_temp)) {
        return Err("Installer path not in allowed directory".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        if p.extension()
            .map(|e| e.eq_ignore_ascii_case("msi"))
            .unwrap_or(false)
        {
            let mut cmd = std::process::Command::new("msiexec");
            crate::process_command::std_no_window(cmd.args(["/i", &installer_path]))
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new(&installer_path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        open::that(&installer_path).map_err(|e| e.to_string())?;
    }
    app.exit(0);
    Ok(())
}
