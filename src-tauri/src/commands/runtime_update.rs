//! 运行环境在线更新（v0.9.7 收版反馈裁决 2026-11-13：多方式依次自动尝试，
//! 不局限单一安装模式）。每运行时一条策略链，一种失败自动尝试下一种：
//!
//! | 运行时 | 策略链 |
//! |---|---|
//! | npm | npm 自更新 |
//! | git | winget → choco → GitHub 安装包静默安装 |
//! | node | winget → choco |
//! | python | winget →（前端兜底：下载页） |
//!
//! 执行层复用 `shell::run_install_command` / `shell::run_powershell_capture`
//! （评审 P2-①：powershell 执行下沉 os_adapter 统一接口；已补用户级 PATH
//! ——winget 可见）；链内命令由本模块构建（不经 IPC 白名单，白名单防的是
//! 外部输入）。评审 P1-4：探测 30s / 安装 600s 限时，超时错误含「超时」并
//! 指引下载页兜底。全链失败返回聚合错误，前端兜底弹「打开下载页」。

use serde::Serialize;

#[derive(Serialize)]
pub struct RuntimeUpdateResult {
    /// 实际成功的方式：npm / winget / choco / installer。
    pub method: String,
    pub output: String,
}

/// 探测（GitHub latest tag 等）限时（评审 P1-4：此前无超时，网络挂起则整条
/// 更新链无限等待）。
const PROBE_TIMEOUT_SECS: u64 = 30;
/// 下载 + 静默安装限时（评审 P1-4：大安装包 + 慢链路，10 分钟上限）。
const INSTALL_TIMEOUT_SECS: u64 = 600;

/// winget「无适用升级」专用退出码（0x8A15002B 的 i32 补码）。评审 P2-③：
/// 「无可升级」判定以退出码为主——该码即「已最新」，是成功结果而非链失败
/// （输出子串仅兜底：老版 winget 退出码 0 只打印消息）。
const WINGET_NO_APPLICABLE_UPDATE: i32 = -1978335189;

#[tauri::command]
pub(crate) async fn runtime_update(id: String) -> Result<RuntimeUpdateResult, String> {
    match id.as_str() {
        "npm" => {
            try_chain(&[("npm", "npm install -g npm@latest")]).await
        }
        "git" => {
            let chain = try_chain(&[
                (
                    "winget",
                    "winget upgrade --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements",
                ),
                ("choco", "choco upgrade git -y"),
            ])
            .await;
            match chain {
                Ok(result) => Ok(result),
                Err(winget_choco_err) => {
                    // 第三跳：GitHub 安装包静默安装（不依赖任何包管理器）。
                    match git_installer_update().await {
                        Ok(output) => Ok(RuntimeUpdateResult {
                            method: "installer".to_string(),
                            output,
                        }),
                        Err(installer_err) => Err(format!(
                            "{winget_choco_err}\n[installer] {installer_err}"
                        )),
                    }
                }
            }
        }
        "node" => {
            try_chain(&[
                (
                    "winget",
                    "winget upgrade --id OpenJS.NodeJS -e --source winget --accept-package-agreements --accept-source-agreements",
                ),
                ("choco", "choco upgrade nodejs-lts -y"),
            ])
            .await
        }
        "python" => {
            try_chain(&[
                (
                    "winget",
                    "winget upgrade --id Python.Python.3 --exact --source winget --accept-package-agreements --accept-source-agreements --allow-unavailable",
                ),
                ("choco", "choco upgrade python -y"),
            ])
            .await
        }
        other => Err(format!("unknown runtime: {other}")),
    }
}

/// 依次尝试命令链；一步成功即返回（真失败走 Err 自动降级到下一跳）。
/// 评审 P2-③：winget「无可升级」= 已最新，按成功返回、不再误降级——
/// 跨渠道重装（winget 说已最新还去 choco 装一遍）有版本回退风险。
async fn try_chain(steps: &[(&str, &str)]) -> Result<RuntimeUpdateResult, String> {
    let mut last_err = String::new();
    for (method, cmd) in steps {
        // 评审 P1-4：链内每步限时（超时错误含「超时」并指引下载页兜底）。
        let step = match tokio::time::timeout(
            std::time::Duration::from_secs(INSTALL_TIMEOUT_SECS),
            crate::os_adapter::shell::run_install_command(cmd, None),
        )
        .await
        {
            Ok(inner) => inner,
            Err(_) => {
                last_err = format!(
                    "[{method}] 运行时更新命令超时（>{INSTALL_TIMEOUT_SECS}s）；请前往官网下载页手动下载安装"
                );
                continue;
            }
        };
        match step {
            Ok(output) => {
                // 退出码 0 + 「无可升级」消息（老版 winget 不带专用退出码）
                // = 已最新：输出子串兜底判定（评审 P2-③），返回成功。
                if output_says_no_upgrade(&output) {
                    return Ok(RuntimeUpdateResult {
                        method: method.to_string(),
                        output: format!("{output}\n[judged] 已是最新版本（无可升级）"),
                    });
                }
                return Ok(RuntimeUpdateResult {
                    method: method.to_string(),
                    output,
                });
            }
            Err(e) => {
                // 退出码为主：winget no-applicable-update 专用退出码 = 已最新。
                if exit_code_of(&e) == Some(WINGET_NO_APPLICABLE_UPDATE)
                    || output_says_no_upgrade(&e)
                {
                    return Ok(RuntimeUpdateResult {
                        method: method.to_string(),
                        output: "已是最新版本（无可升级）".to_string(),
                    });
                }
                last_err = format!("[{method}] {e}");
            }
        }
    }
    Err(last_err)
}

/// 从 run_install_command 的错误串提取退出码
/// （形如 "command failed (exit Some(-1978335189)): …"；无法解析返回 None）。
fn exit_code_of(err: &str) -> Option<i32> {
    let start = err.find("exit ")? + "exit ".len();
    let rest = &err[start..];
    let end = rest.find(')')?;
    rest[..end]
        .trim()
        .strip_prefix("Some(")?
        .trim_end_matches(')')
        .parse()
        .ok()
}

/// 「无可升级」输出子串判据（保留原判据作兜底——评审 P2-③：退出码为主，
/// 子串仅辅助）。winget 消息本地化，故同时覆盖英文与中文系统文案。
fn output_says_no_upgrade(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("no available upgrades")
        || lower.contains("no applicable upgrade")
        || lower.contains("未找到任何")
}

/// git 第三跳：GitHub latest 安装包下载 + 静默安装（InnoSetup
/// /VERYSILENT /CURRENTUSER 用户级免提权；失败自然进链尾聚合错误）。
/// 下载与执行一条 powershell 完成（走系统代理——与版本探测同通路）。
/// 评审 P1-4：探测 30s / 安装 600s 限时。
async fn git_installer_update() -> Result<String, String> {
    // 1) 取 latest tag（复用 os_adapter 的 powershell 通路——评审 P2-①）。
    let tag_script =
        "(Invoke-WebRequest -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing).Content | ConvertFrom-Json | Select-Object -ExpandProperty tag_name";
    let tag = crate::os_adapter::shell::run_powershell_capture(&tag_script, PROBE_TIMEOUT_SECS)
        .await
        .map_err(|e| format!("[probe] {e}"))?;
    let tag = tag.trim().trim_matches('"').trim().to_string();
    // 评审 P2-②：tag 拼进下载 URL 与 powershell 脚本前过白名单——API 返回
    // 被篡改/异常时直接报错走链尾（前端兜底下载页），杜绝命令注入。
    if !is_safe_git_tag(&tag) {
        return Err(format!("latest tag 不合法，放弃安装包方式: {tag}"));
    }
    // tag 形如 v2.51.0.windows.1 → 文件名 Git-2.51.0-64-bit.exe；
    // windows.N(N>1) → Git-2.51.0-{N-1}-64-bit.exe。
    let core = tag.trim_start_matches('v');
    let (base, rev) = match core.split_once(".windows.") {
        Some((b, n)) => {
            let n: u32 = n.parse().map_err(|_| format!("unexpected tag {tag}"))?;
            (
                b.to_string(),
                if n > 1 {
                    format!("-{}", n - 1)
                } else {
                    String::new()
                },
            )
        }
        None => (core.to_string(), String::new()),
    };
    let file = format!("Git-{base}{rev}-64-bit.exe");
    let url = format!("https://github.com/git-for-windows/git/releases/download/{tag}/{file}");
    // 2) 下载到临时目录并静默安装（-Wait 拿退出码）。
    let script = format!(
        "$tmp = Join-Path $env:TEMP 'jishu-git-update.exe'; \
         Invoke-WebRequest -Uri '{url}' -OutFile $tmp -UseBasicParsing; \
         $p = Start-Process -FilePath $tmp -ArgumentList '/VERYSILENT,/NORESTART,/CURRENTUSER,/SUPPRESSMSGBOXES' -Wait -PassThru; \
         exit $p.ExitCode"
    );
    crate::os_adapter::shell::run_powershell_capture(&script, INSTALL_TIMEOUT_SECS)
        .await
        .map(|_| "installer ok".to_string())
}

/// git-for-windows tag 白名单（评审 P2-②）：`^v?\d+(\.\d+)*(\.windows\.\d+)?$`
/// ——只放行纯版本形态（v2.51.0 / 2.51.0 / v2.51.0.windows.1），含引号、
/// 分号、反引号、$、空格等注入载荷一律拒绝。
fn is_safe_git_tag(tag: &str) -> bool {
    use regex::Regex;
    static SAFE_TAG: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = SAFE_TAG.get_or_init(|| Regex::new(r"^v?\d+(\.\d+)*(\.windows\.\d+)?$").unwrap());
    re.is_match(tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 评审 P2-②：tag 白名单——合法版本放行，注入/异常形态全拒。
    #[test]
    fn git_tag_whitelist() {
        // 合法：带/不带 v 前缀、多段、windows 修订。
        assert!(is_safe_git_tag("v2.51.0"));
        assert!(is_safe_git_tag("2.51.0"));
        assert!(is_safe_git_tag("v2.51.0.windows.1"));
        assert!(is_safe_git_tag("2.50.1.windows.2"));
        assert!(is_safe_git_tag("2.51"));
        assert!(is_safe_git_tag("v2"));
        // 注入载荷：powershell 元字符/引号/分号/反引号/子命令/换行。
        assert!(!is_safe_git_tag("'; Remove-Item C:\\ -Recurse; '"));
        assert!(!is_safe_git_tag("2.51.0'; whoami"));
        assert!(!is_safe_git_tag("$(calc)"));
        assert!(!is_safe_git_tag("2.51.0 `r`n"));
        assert!(!is_safe_git_tag("v2.51.0.windows.1; exit 1"));
        // 异常形态：空串/前导点/字母/双点/尾点/中文。
        assert!(!is_safe_git_tag(""));
        assert!(!is_safe_git_tag(".2.51.0"));
        assert!(!is_safe_git_tag("2.5a.0"));
        assert!(!is_safe_git_tag("2..51"));
        assert!(!is_safe_git_tag("2.51."));
        assert!(!is_safe_git_tag("v2.51.0.最新"));
    }

    /// 评审 P2-③：退出码从 run_install_command 错误串中的提取。
    #[test]
    fn extracts_exit_code_from_install_error() {
        assert_eq!(
            exit_code_of("command failed (exit Some(-1978335189)): No applicable upgrade"),
            Some(-1978335189)
        );
        assert_eq!(exit_code_of("command failed (exit Some(1)): boom"), Some(1));
        assert_eq!(exit_code_of("command failed (exit None): aborted"), None);
        assert_eq!(exit_code_of("failed to spawn powershell: x"), None);
    }

    /// 评审 P2-③：「无可升级」子串兜底判据（winget 中英文文案；子串集合
    /// 与既有判据逐字对齐——"no available upgrades" 为复数形态）。
    #[test]
    fn no_upgrade_substring_judgment() {
        assert!(output_says_no_upgrade("No available upgrades found."));
        assert!(output_says_no_upgrade("No applicable upgrade found."));
        assert!(output_says_no_upgrade("未找到任何适用升级"));
        assert!(!output_says_no_upgrade("Successfully installed"));
        assert!(!output_says_no_upgrade(
            "command failed (exit Some(1)): network error"
        ));
    }
}
