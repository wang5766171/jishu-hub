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
//! 执行层复用 `shell::run_install_command`（已补用户级 PATH——winget 可见）；
//! 链内命令由本模块构建（不经 IPC 白名单，白名单防的是外部输入）。全链
//! 失败返回聚合错误，前端兜底弹「打开下载页」。

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateResult {
    /// 实际成功的方式：npm / winget / choco / installer。
    pub method: String,
    pub output: String,
}

#[tauri::command]
pub(crate) async fn runtime_update(id: String) -> Result<RuntimeUpdateResult, String> {
    match id.as_str() {
        "npm" => {
            try_chain(&[
                ("npm", "npm install -g npm@latest"),
            ])
            .await
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

/// 依次尝试命令链；一步成功即返回（winget 的「无可升级」等失败走 Err
/// 自动降级到下一跳）。
async fn try_chain(steps: &[(&str, &str)]) -> Result<RuntimeUpdateResult, String> {
    let mut last_err = String::new();
    for (method, cmd) in steps {
        match crate::os_adapter::shell::run_install_command(cmd, None).await {
            Ok(output) => {
                // winget「无可用的升级」退出码 0 但输出含 No applicable/未找到
                // ——视为失败继续降级。
                let lower = output.to_lowercase();
                if lower.contains("no available upgrades")
                    || lower.contains("no applicable upgrade")
                    || lower.contains("未找到任何")
                {
                    last_err = format!("[{method}] no available upgrade");
                    continue;
                }
                return Ok(RuntimeUpdateResult {
                    method: method.to_string(),
                    output,
                });
            }
            Err(e) => {
                last_err = format!("[{method}] {e}");
            }
        }
    }
    Err(last_err)
}

/// git 第三跳：GitHub latest 安装包下载 + 静默安装（InnoSetup
/// /VERYSILENT /CURRENTUSER 用户级免提权；失败自然进链尾聚合错误）。
/// 下载与执行一条 powershell 完成（走系统代理——与版本探测同通路）。
async fn git_installer_update() -> Result<String, String> {
    // 1) 取 latest tag（复用 update.rs 的 powershell 通路——此处直取，
    //    避免私有函数跨模块）。
    let tag_script =
        "(Invoke-WebRequest -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing).Content | ConvertFrom-Json | Select-Object -ExpandProperty tag_name";
    let tag = run_powershell_capture(tag_script).await?;
    let tag = tag.trim().trim_matches('"').trim().to_string();
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
    run_powershell_capture(&script)
        .await
        .map(|_| "installer ok".to_string())
}

/// powershell 执行并取 stdout（补用户级 PATH + 无窗口）。
async fn run_powershell_capture(script: &str) -> Result<String, String> {
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", script]);
    let cmd = crate::process_command::extend_path_for_child_std(&mut cmd);
    let output = crate::process_command::std_no_window(cmd)
        .output()
        .map_err(|e| format!("failed to spawn powershell: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}
