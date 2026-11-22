//! 需求18（v0.9.8）：TUI `jishu` 命令生命周期管理（hub 系统级自愈）。
//!
//! 产品语义（用户裁决 2026-11-22：「手工解决有啥用，普通用户遇到怎么办，
//! 要系统层级解决」）：`jishu` 命令 = pi fork coding-agent 的 bin 名，是
//! 用户进 TUI 的入口——**hub 全权负责其存在性**：启动时幂等检测，缺失/
//! 死链则静默写 shim 到 npm 全局 bin（`%APPDATA%\npm`，Windows npm 默认
//! 安装位置，必在 PATH）；正常（任意来源，含用户 npm link）则不动。
//!
//! 设计约束：
//! - 纯文件操作零子进程（不拖启动；不依赖 npm prefix 探测——标准位置
//!   覆盖默认安装，非标准位置归 doctor 诊断提示）；
//! - 幂等：shim 存在且指向的 cli.js 有效 → no-op；指向失效目标（pi 目录
//!   重建/升级后的死链）→ 重写；
//! - 覆盖 npm link 的同名 shim 是安全的（直指 cli.js 比经 node_modules
//!   junction 更稳；junction 残留无害）；
//! - pi 未装（cli.js 不存在）→ 跳过记日志（装机流程负责 pi 本体）。

use std::path::PathBuf;

/// pi fork cli 入口（bin 名 jishu 的本体）。
fn cli_target() -> Option<PathBuf> {
    let root = crate::agent::jishu_self::paths::agent_root_for_home(
        &dirs::home_dir()?,
    );
    let cli = root
        .join("packages")
        .join("coding-agent")
        .join("dist")
        .join("bundle")
        .join("cli.js");
    cli.is_file().then_some(cli)
}

/// npm 全局 bin（Windows 默认 `%APPDATA%\npm`；unix `~/.local/bin`——
/// 不在 PATH 时 doctor 提示，不自动改 shell 配置）。
fn shim_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        let dir = std::env::var("APPDATA").ok()?.trim().to_string();
        if dir.is_empty() {
            return None;
        }
        let npm_bin = PathBuf::from(dir).join("npm");
        npm_bin.is_dir().then_some(npm_bin)
    } else {
        let home = dirs::home_dir()?;
        let dir = home.join(".local").join("bin");
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir)
    }
}

/// Windows cmd shim 内容（绝对路径展开——每台机器生成时定死，跨用户
/// 机器不可移植但 shim 本就是本机产物）。
fn cmd_shim_content(cli: &PathBuf) -> String {
    format!(
        "@echo off\r\nnode \"{}\" %*\r\n",
        cli.to_string_lossy()
    )
}

/// unix sh shim 内容。
fn sh_shim_content(cli: &PathBuf) -> String {
    format!("#!/bin/sh\nexec node \"{}\" \"$@\"\n", cli.to_string_lossy())
}

/// shim 是否有效：存在、文本指向 cli_target 且目标在。
fn shim_valid(shim: &PathBuf, cli: &PathBuf) -> bool {
    let Ok(text) = std::fs::read_to_string(shim) else {
        return false;
    };
    // 引用目标在（直指本机 cli.js 路径）。
    text.contains(&cli.to_string_lossy().to_string()) && cli.is_file()
}

/// 启动自愈入口（lib.rs setup 挂点；幂等，失败仅日志不阻断启动）。
pub fn ensure_jishu_command_shim() {
    let Some(cli) = cli_target() else {
        log::info!("[jishu-shim] pi cli.js 不存在（pi 未部署），跳过命令自愈");
        return;
    };
    let Some(dir) = shim_dir() else {
        log::warn!("[jishu-shim] npm 全局 bin 目录不可用（非标准 npm 安装？），jishu 命令自愈跳过——可用 doctor 诊断");
        return;
    };
    if cfg!(windows) {
        // 双通道独立判断（一方有效不掩盖另一方缺失）：cmd（CMD/PowerShell）
        // + 无扩展 sh（git-bash/WSL——bash 不解析 .cmd）。
        let cmd_shim = dir.join("jishu.cmd");
        if !shim_valid(&cmd_shim, &cli) {
            let existed = cmd_shim.exists();
            match std::fs::write(&cmd_shim, cmd_shim_content(&cli)) {
                Ok(()) => log::info!(
                    "[jishu-shim] {} jishu 命令 shim（{}）",
                    if existed { "重写" } else { "写入" },
                    cmd_shim.display()
                ),
                Err(e) => log::warn!("[jishu-shim] 写入 {} 失败: {e}", cmd_shim.display()),
            }
        }
        let sh_shim = dir.join("jishu");
        if !shim_valid(&sh_shim, &cli) {
            if let Err(e) = std::fs::write(&sh_shim, sh_shim_content(&cli)) {
                log::warn!("[jishu-shim] 写入 git-bash 通道 {} 失败: {e}", sh_shim.display());
            }
        }
    } else {
        let shim = dir.join("jishu");
        if shim_valid(&shim, &cli) {
            return;
        }
        let content = sh_shim_content(&cli);
        match std::fs::write(&shim, content)
            .and_then(|_| set_executable(&shim))
        {
            Ok(()) => log::info!("[jishu-shim] 写入 jishu 命令 shim（{}）", shim.display()),
            Err(e) => log::warn!("[jishu-shim] 写入 {} 失败: {e}", shim.display()),
        }
    }
}

#[cfg(unix)]
fn set_executable(path: &PathBuf) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perm = std::fs::metadata(path)?.permissions();
    perm.set_mode(0o755);
    std::fs::set_permissions(path, perm)
}

#[cfg(windows)]
fn set_executable(_path: &PathBuf) -> std::io::Result<()> {
    Ok(())
}

/// 诊断入口（doctor 消费）：jishu 命令健康态。
pub fn diagnose() -> String {
    let Some(cli) = cli_target() else {
        return "异常：pi cli.js 缺失（~/.jishu-agent 未部署或损坏）".to_string();
    };
    let Some(dir) = shim_dir() else {
        return "提示：npm 全局 bin 不可用——非标准 npm 安装位置，jishu 命令无法自动管理".to_string();
    };
    let shim = if cfg!(windows) {
        dir.join("jishu.cmd")
    } else {
        dir.join("jishu")
    };
    let _ = dir.join("jishu"); // Windows 下另有 git-bash 通道（同目录无扩展脚本）
    if shim_valid(&shim, &cli) {
        format!("正常：jishu 命令就绪（{}）", shim.display())
    } else {
        format!(
            "已自愈/下次启动自愈：shim 待写入（{}；也可手动执行 npm link 或重启 hub）",
            shim.display()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_shim_content_references_cli_with_args() {
        let cli = PathBuf::from(r"C:\Users\x\.jishu-agent\packages\coding-agent\dist\bundle\cli.js");
        let content = cmd_shim_content(&cli);
        assert!(content.starts_with("@echo off"));
        assert!(content.contains(&cli.to_string_lossy().to_string()));
        assert!(content.contains("%*"), "参数透传");
    }

    #[test]
    fn shim_valid_requires_live_target() {
        let tmp = tempfile::tempdir().unwrap();
        let cli = tmp.path().join("cli.js");
        std::fs::write(&cli, "// tui").unwrap();
        let shim = tmp.path().join("jishu.cmd");
        std::fs::write(&shim, cmd_shim_content(&cli)).unwrap();
        assert!(shim_valid(&shim, &cli));
        // 目标消失（pi 目录重建窗口）→ 失效需重写。
        std::fs::remove_file(&cli).unwrap();
        assert!(!shim_valid(&shim, &cli));
        // 无 shim → 失效。
        assert!(!shim_valid(&tmp.path().join("nope.cmd"), &cli));
    }
}
