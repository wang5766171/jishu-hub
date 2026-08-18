use std::path::Path;
use std::process::Command as StdCommand;
use std::time::Duration;
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

#[derive(Debug, Clone)]
pub struct ShellOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

/// Build a platform-aware command. On Windows, .cmd/.bat scripts (npm, npx, etc.)
/// must be invoked via `cmd /C <command>` since `Command::new("npm")` won't resolve
/// npm.cmd. On Unix, invoke the binary directly.
pub fn shell_command(program: &str, args: Vec<String>) -> TokioCommand {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = TokioCommand::new("cmd");
        let mut full_args = vec!["/C".to_string(), program.to_string()];
        full_args.extend(args);
        cmd.args(&full_args);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = TokioCommand::new(program);
        cmd.args(&args);
        cmd
    }
}

pub async fn run_shell_command(
    command: &str,
    current_dir: Option<&Path>,
    timeout_ms: Option<u64>,
) -> Result<ShellOutput, String> {
    #[cfg(target_os = "windows")]
    let mut process = {
        let mut process = TokioCommand::new("cmd");
        process.arg("/C").arg(command);
        process
    };

    #[cfg(not(target_os = "windows"))]
    let mut process = {
        let mut process = TokioCommand::new("sh");
        process.arg("-c").arg(command);
        process
    };

    if let Some(current_dir) = current_dir {
        process.current_dir(current_dir);
    }
    process.kill_on_drop(true);
    crate::process_command::tokio_no_window(&mut process);

    let execution = process.output();
    let output = if let Some(timeout_ms) = timeout_ms {
        timeout(Duration::from_millis(timeout_ms), execution)
            .await
            .map_err(|_| format!("command timed out after {timeout_ms} ms"))?
            .map_err(|error| format!("failed to run command: {error}"))?
    } else {
        execution
            .await
            .map_err(|error| format!("failed to run command: {error}"))?
    };

    Ok(ShellOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code(),
    })
}

/// Run an arbitrary install or multi-line command with standard error capturing.
/// Windows: uses `powershell -NoProfile -Command`
/// Unix: uses `sh -c`
pub async fn run_install_command(
    command: &str,
    current_dir: Option<&std::path::Path>,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        // v0.7.4 缺陷修复（2026-08-16 二/三次迭代）：choco 机器级安装统一经
        // UAC 授权弹窗提权执行——管理员上下文先清理 chocolatey\lib 下崩溃
        // 残留的 NuGet 锁文件，再执行安装；runas 进程无法管道捕获输出，经
        // 临时文件回传。npm / winget 维持非提权直跑。choco 命令统一补 `-y`
        // 非交互化（提权窗口隐藏，交互确认无人可答——曾导致安装无限挂起）。
        // 非 choco 命令预置 UTF-8 控制台编码，避免中文系统 OEM 代码页乱码。
        let command = normalize_choco_command(command);
        let command = command.as_str();
        if is_choco_install_command(command) {
            return run_elevated_choco_install(command).await;
        }
        let prefixed = format!(
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; {}",
            command
        );
        let mut installer = StdCommand::new("powershell");
        installer.args(["-NoProfile", "-Command", &prefixed]);
        if let Some(dir) = current_dir {
            installer.current_dir(dir);
        }
        let output = crate::process_command::std_no_window(&mut installer)
            .output()
            .map_err(|e| format!("Failed to spawn powershell: {}", e))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            // npm/winget often write failure detail to stdout rather than
            // stderr; prefer stderr but fall back to stdout, and always
            // include the exit code so the error is never empty.
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let detail = if !stderr.is_empty() { stderr } else { stdout };
            Err(format!(
                "command failed (exit {:?}): {}",
                output.status.code(),
                detail
            ))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut installer = StdCommand::new("sh");
        installer.args(["-c", command]);
        if let Some(dir) = current_dir {
            installer.current_dir(dir);
        }

        let output = crate::process_command::std_no_window(&mut installer)
            .output()
            .map_err(|e| format!("Failed to spawn sh: {}", e))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let detail = if !stderr.is_empty() { stderr } else { stdout };
            Err(format!(
                "command failed (exit {:?}): {}",
                output.status.code(),
                detail
            ))
        }
    }
}

// -------------------- chocolatey 提权安装（Windows） --------------------

/// 仅 `choco install/upgrade <安全包名> [-y|--yes]` 允许进入提权路径。
/// agent_install.rs 的白名单已在入口收敛命令形态，这里按同一字符集
/// 复核一遍（纵深防御：确保嵌入 PowerShell 脚本的内容无引号/分号等）。
#[cfg(target_os = "windows")]
fn is_choco_install_command(command: &str) -> bool {
    let cmd = command.trim();
    for prefix in ["choco install ", "choco upgrade "] {
        if let Some(rest) = cmd.strip_prefix(prefix) {
            let mut tokens = rest.split_whitespace();
            let Some(pkg) = tokens.next() else {
                return false;
            };
            let pkg_ok = pkg.chars().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '.' | '_' | '-' | '+')
            });
            // 仅放行我们归一化补入的确认旗标，其余旗标一律拒绝。
            let flags_ok = tokens.all(|t| t == "-y" || t == "--yes");
            return pkg_ok && flags_ok;
        }
    }
    false
}

/// choco 命令非交互化：install/upgrade 且未携带 -y/--yes/--confirm 时补
/// `-y`——提权窗口隐藏（-WindowStyle Hidden），交互确认无人可答，会无限
/// 挂起（2026-08-16 实测：卡在 "Do you want to run the script?"）。
#[cfg(target_os = "windows")]
fn normalize_choco_command(command: &str) -> String {
    let cmd = command.trim();
    let is_choco = cmd.starts_with("choco install ") || cmd.starts_with("choco upgrade ");
    if !is_choco {
        return cmd.to_string();
    }
    let has_yes = cmd
        .split_whitespace()
        .any(|t| t == "-y" || t == "--yes" || t == "--confirm");
    if has_yes {
        cmd.to_string()
    } else {
        format!("{cmd} -y")
    }
}

/// 该安装命令是否需要管理员权限（choco 机器级安装）。前端据此在触发
/// UAC 前弹应用内说明并征得用户同意（v0.7.4：升权原因先告知用户）。
pub(crate) fn command_requires_elevation(command: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        let normalized = normalize_choco_command(command);
        is_choco_install_command(&normalized)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
        false
    }
}

/// 提权内层脚本（在管理员 PowerShell 中执行）：UTF-8 输出编码 → 清理
/// chocolatey\lib 下 40 位 hex 的陈旧 NuGet 锁文件 → 执行安装 →
/// 全部输出流重定向到临时文件 → 以安装命令的退出码退出。
#[cfg(target_os = "windows")]
fn build_elevated_inner(command: &str, out_path: &str) -> String {
    format!(
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n\
         $chocoRoot = if ($env:ChocolateyInstall) {{ $env:ChocolateyInstall }} else {{ 'C:\\ProgramData\\chocolatey' }}\n\
         Get-ChildItem -LiteralPath (Join-Path $chocoRoot 'lib') -File -ErrorAction SilentlyContinue | Where-Object {{ $_.Name -match '^[0-9a-fA-F]{{40}}$' }} | Remove-Item -Force -ErrorAction SilentlyContinue\n\
         & {command} *> '{out_path}'\n\
         exit $LASTEXITCODE"
    )
}

/// 提权外层脚本（当前用户 PowerShell）：UAC 授权（-Verb RunAs，已是管理员
/// 时不弹窗）+ 等待退出 → 回读并输出临时文件内容 → 清理 → 透传退出码。
/// 用户在 UAC 弹窗点「否」时 Start-Process 抛错，映射为 1223（ERROR_CANCELLED）。
#[cfg(target_os = "windows")]
fn build_elevated_outer(out_path: &str, encoded_inner: &str) -> String {
    format!(
        "$code = 1\n\
         $tmp = '{out_path}'\n\
         try {{\n\
           $p = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ArgumentList @('-NoProfile','-EncodedCommand','{encoded_inner}')\n\
           if ($null -ne $p.ExitCode) {{ $code = $p.ExitCode }}\n\
         }} catch {{ $code = 1223 }}\n\
         if (Test-Path -LiteralPath $tmp) {{ Get-Content -LiteralPath $tmp -Raw }}\n\
         Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue\n\
         exit $code"
    )
}

/// choco 提权安装执行器。输出经临时文件回传（runas 进程无法直接管道捕获）。
#[cfg(target_os = "windows")]
async fn run_elevated_choco_install(command: &str) -> Result<String, String> {
    use base64::Engine as _;
    let out_path = std::env::temp_dir()
        .join(format!("jishu-install-{}.log", uuid::Uuid::new_v4()))
        .display()
        .to_string();
    let inner = build_elevated_inner(command, &out_path);
    // -EncodedCommand 要求 UTF-16LE 字节流的标准 base64。
    let utf16le: Vec<u8> = inner.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16le);
    let outer = build_elevated_outer(&out_path, &encoded);

    let mut installer = StdCommand::new("powershell");
    installer.args(["-NoProfile", "-Command", &outer]);
    let output = crate::process_command::std_no_window(&mut installer)
        .output()
        .map_err(|e| format!("Failed to spawn powershell: {}", e))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    if output.status.code() == Some(1223) {
        // v0.7.4 审查 B1：稳定错误码而非中文直出——前端（env-check 安装
        // 流程）按码映射本地化提示，与导出对话框 USER_CANCELLED 同一惯例。
        return Err("UAC_CANCELLED".to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    let mut err = format!(
        "command failed (exit {:?}): {}",
        output.status.code(),
        detail
    );
    err.push_str(&choco_failure_hint(&detail));
    Err(err)
}

/// 从 choco 失败输出中提取锁文件路径：
/// "Unable to obtain lock file access on '<path>' for operations on ..."。
#[cfg(target_os = "windows")]
fn extract_lock_path(detail: &str) -> Option<String> {
    detail
        .find("Unable to obtain lock file access on '")
        .and_then(|start| {
            let rest = &detail[start + "Unable to obtain lock file access on '".len()..];
            rest.find('\'').map(|end| rest[..end].to_string())
        })
}

/// choco 失败时的可操作指引（中文，附加在原始错误后）。
/// 提权路径下锁文件已自动清理，仍报锁冲突多半是并发安装占用了锁。
#[cfg(target_os = "windows")]
fn choco_failure_hint(detail: &str) -> String {
    let lock_path = extract_lock_path(detail);
    let access_denied = detail.contains("UnauthorizedAccessException")
        || detail.contains("lib-bad")
        || detail.contains("访问被拒绝");
    let mut hint = String::from("\n\n[choco] ");
    if let Some(path) = lock_path {
        hint.push_str(&format!(
            "Chocolatey 锁文件冲突（安装前已自动清理陈旧锁，仍冲突多为有并发 chocolatey 安装）。请确认没有其他安装进行中，必要时删除 {path} 后重试。"
        ));
    } else if access_denied {
        hint.push_str("对 chocolatey 目录操作被拒绝。请以管理员身份运行 Jishu Hub 后重试。");
    } else {
        return String::new();
    }
    hint
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(target_os = "windows")]
    fn choco_elevation_guard() {
        assert!(super::is_choco_install_command("choco install opencode"));
        assert!(super::is_choco_install_command("choco install opencode -y"));
        assert!(super::is_choco_install_command("choco upgrade git --yes"));
        // 与白名单同字符集复核：引号/分号/空格包名/未知旗标一律不进提权路径。
        assert!(!super::is_choco_install_command(
            "choco install opencode; whoami"
        ));
        assert!(!super::is_choco_install_command("choco install "));
        assert!(!super::is_choco_install_command(
            "choco install opencode --force"
        ));
        assert!(!super::is_choco_install_command(
            "npm install -g opencode-ai"
        ));
        assert!(!super::is_choco_install_command(
            "winget install --id Git.Git -e"
        ));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn choco_commands_are_made_non_interactive() {
        assert_eq!(
            super::normalize_choco_command("choco install opencode"),
            "choco install opencode -y"
        );
        assert_eq!(
            super::normalize_choco_command("choco upgrade git"),
            "choco upgrade git -y"
        );
        // 已带确认旗标 / 非 choco 命令不动。
        assert_eq!(
            super::normalize_choco_command("choco install opencode --yes"),
            "choco install opencode --yes"
        );
        assert_eq!(
            super::normalize_choco_command("npm install -g x"),
            "npm install -g x"
        );
    }

    #[test]
    fn elevation_query_matches_choco_only() {
        assert!(super::command_requires_elevation("choco install opencode"));
        assert!(!super::command_requires_elevation(
            "npm install -g opencode-ai"
        ));
        assert!(!super::command_requires_elevation(
            "winget install --id Git.Git -e --source winget"
        ));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn elevated_inner_script_shape() {
        let inner = super::build_elevated_inner("choco install opencode", r"C:\t\out.log");
        assert!(inner.starts_with("[Console]::OutputEncoding"));
        // 管理员上下文先清理 40-hex NuGet 锁文件再安装。
        assert!(inner.contains("^[0-9a-fA-F]{40}$"));
        assert!(inner.contains("Remove-Item -Force"));
        assert!(inner.contains("& choco install opencode *> 'C:\\t\\out.log'"));
        assert!(inner.trim_end().ends_with("exit $LASTEXITCODE"));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn elevated_outer_script_shape() {
        let outer = super::build_elevated_outer(r"C:\t\out.log", "RU5DT0RFRA==");
        assert!(outer.contains("-Verb RunAs"));
        assert!(outer.contains("'-EncodedCommand','RU5DT0RFRA=='"));
        // 用户拒绝 UAC → 1223；结束前回读并清理临时文件。
        assert!(outer.contains("$code = 1223"));
        assert!(outer.contains("Get-Content -LiteralPath $tmp -Raw"));
        assert!(outer.contains("Remove-Item -LiteralPath $tmp"));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn extracts_lock_path_from_choco_output() {
        let detail = "Unable to obtain lock file access on 'C:\\ProgramData\\chocolatey\\lib\\595286e4148e792fb4636adee1444f05168d2256' for operations on 'C:\\ProgramData\\chocolatey\\lib\\fzf'.";
        assert_eq!(
            super::extract_lock_path(detail).as_deref(),
            Some(r"C:\ProgramData\chocolatey\lib\595286e4148e792fb4636adee1444f05168d2256")
        );
        assert!(super::extract_lock_path("some other failure").is_none());
    }
}
