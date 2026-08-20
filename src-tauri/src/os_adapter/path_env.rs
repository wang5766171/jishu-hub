//! v0.7.6 需求1：npm 全局命令目录的用户 PATH 补全。
//!
//! 背景：Node.js 安装器通常会把 npm 全局 bin 目录（Windows 默认
//! `%APPDATA%\npm`）写入用户 PATH；Node 装到自定义路径的机器可能缺失该
//! 条目。此时 Hub 内 `npm install -g` 成功、agent 探测（候选路径文件
//! 存在性）也显示已安装，但用户命令行（新开 PowerShell/cmd）无法识别
//! 命令——2026-08-19 用户实测：Hub 安装 codex 后命令行 not recognized。
//!
//! 本模块在 npm 全局安装成功后把该目录追加进用户 PATH 注册表：
//! - 类型安全：经 Registry API 以「不展开环境变量」方式读原值与值类型
//!   （REG_EXPAND_SZ 的 `%VAR%` 引用不丢失），按原类型写回；
//! - 广播 `WM_SETTINGCHANGE`，让资源管理器与新进程尽快感知；
//! - 与 Machine PATH / 已展开段对比，命中任一即跳过（不重复追加）；
//! - 任何失败静默返回 `None`，绝不中断安装主流程（§17.5 盲端安全准则）；
//! - 非 Windows 平台 no-op：npm 全局 bin 默认在 `/usr/local/bin` 等
//!   既有 PATH 目录，缺失场景多由 nvm/shell rc 管理，不擅自动 shell 配置。

use std::time::Duration;
use tokio::time::timeout;

/// 追加成功时返回被追加的目录；已存在 / 无法确定 / 平台不适用返回 None。
pub async fn ensure_npm_global_bin_on_user_path() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        ensure_on_windows().await
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// PowerShell 单脚本完成：npm prefix 解析 → 存在性/重复性检查 →
/// 注册表类型安全追加 → 广播。输出行协议：`APPENDED:<dir>` /
/// `SKIP:<reason>`，Rust 侧只关心 APPENDED。
#[cfg(target_os = "windows")]
const ENSURE_PATH_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$line = (& npm config get prefix --loglevel=error 2>$null) |
  Where-Object { $_ -match '^[A-Za-z]:[\\/]' } | Select-Object -First 1
if (-not $line) { Write-Output 'SKIP:no-prefix'; exit 0 }
$binDir = [System.IO.Path]::GetFullPath($line.Trim())
if (-not (Test-Path -LiteralPath $binDir)) { Write-Output 'SKIP:no-dir'; exit 0 }
$norm = $binDir.TrimEnd('\').ToLowerInvariant()
# 任一来源已含该目录（展开后的机器/用户 PATH / 当前进程 PATH）即跳过。
# 用户 PATH 以 GetEnvironmentVariable 展开读取——REG_EXPAND_SZ 的
# %APPDATA%\npm 引用形态展开后同样命中，避免重复追加字面路径。
$machinePath = [string][Environment]::GetEnvironmentVariable('PATH', 'Machine')
$userPath = [string][Environment]::GetEnvironmentVariable('PATH', 'User')
foreach ($src in @($machinePath, $userPath, $env:PATH)) {
  foreach ($p in ($src -split ';')) {
    $t = $p.Trim().TrimEnd('\').ToLowerInvariant()
    if ($t -eq $norm) { Write-Output 'SKIP:present'; exit 0 }
  }
}
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -eq $key) { Write-Output 'SKIP:no-key'; exit 0 }
$raw = $key.GetValue('PATH', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$kind = if ($null -eq $raw) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $key.GetValueKind('PATH') }
$cur = if ($null -eq $raw) { '' } else { [string]$raw }
$key.Close()
$parts = @($cur -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$new = if ($parts.Count -gt 0) { ($parts -join ';') + ';' + $binDir } else { $binDir }
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$key.SetValue('PATH', $new, $kind)
$key.Close()
Add-Type -Namespace Win32 -Name JishuNative -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
$r = [UIntPtr]::Zero
[Win32.JishuNative]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r) | Out-Null
Write-Output "APPENDED:$binDir"
"#;

#[cfg(target_os = "windows")]
async fn ensure_on_windows() -> Option<String> {
    let mut child = tokio::process::Command::new("powershell");
    child.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        ENSURE_PATH_SCRIPT,
    ]);
    crate::process_command::tokio_no_window(&mut child);
    // npm config 冷启动 + Add-Type 编译各需数秒，留足裕量；超时视为放弃。
    let output = timeout(Duration::from_secs(30), child.output())
        .await
        .ok()?
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find_map(|line| line.strip_prefix("APPENDED:"))
        .map(|dir| dir.trim().to_string())
}
