pub(crate) mod config;
pub(crate) mod jishu_settings;
pub mod model_picker;
pub(crate) mod paths;
pub(crate) mod pi_model;
pub(crate) mod pi_models_config;
pub(crate) mod pi_registry;
pub(crate) mod pi_runtime;
pub(crate) mod pi_session;
pub(crate) mod pi_tools_config;
// 需求7 补充（v0.9.8）：/ 命令清单对齐 TUI——get_commands 一次性探针。
pub(crate) mod slash_commands;
mod probe;
pub(crate) mod session_title;

use crate::agent::capability::AgentCapabilities;
use crate::agent::{AgentInfo, ChatRequest, ResolvedSessionPromptInjection};
use crate::project_config::ProjectSettings;
use std::path::PathBuf;

pub struct JishuSelfAgent;

impl JishuSelfAgent {
    pub fn new() -> Self {
        Self
    }

    /// Standalone async MCP ensure — does not borrow &self, so it can be
    /// awaited without holding the AgentRegistry MutexGuard.
    /// v0.9.5 需求11（pi 1.1.0）：pi 原生 MCP client 落地，pi-mcp-adapter
    /// 扩展退役（D0 开源优先：上游原生覆盖桥接层）——本方法改为「确保
    /// pi 用户级 mcp.json 的 jishu-hub 条目 + 清理 adapter 残留」。
    pub async fn install_mcp_standalone() -> Result<String, String> {
        Self::ensure_native_mcp_entry().await
    }

    /// pi-mcp-adapter（已退役）安装位置残留检测——pi install npm:pkg 落
    /// `<config_dir>/npm/node_modules/<pkg>`，与 check_mcp 的
    /// adapter_residual 同口径（存在即需 cleanup_retired_adapter 清理）。
    pub(crate) fn mcp_adapter_dir() -> Option<std::path::PathBuf> {
        pi_config_dir().map(|dir| {
            std::path::Path::new(&dir)
                .join("npm")
                .join("node_modules")
                .join("pi-mcp-adapter")
        })
    }

    /// v0.9.5 需求11：pi 原生 MCP 接入自愈（幂等）——hub 安装期/启动后台
    /// 共用：①确保 `~/.jishu-agent/agent/mcp.json`（pi 原生用户级位，
    /// configDir 下）有 jishu-hub 条目（command=jishu-cli, args=[mcp,serve]，
    /// 与其他三家同构）；②清理退役 adapter 残留（settings.json packages
    /// 条目 + npm/node_modules 目录）——残留的 `/mcp` 命令会压制 pi 内置
    /// builtin:mcp 扩展（实测 pi 1.1.0 警告二选一）。纯文件操作，离线可用。
    /// 返回描述性消息（changed=true 表示本次有变更）。
    pub async fn ensure_native_mcp_entry() -> Result<String, String> {
        let mut changed = false;
        // ① mcp.json 条目（键级，不动用户其它 server 条目）
        match Self::upsert_native_hub_entry() {
            Ok(c) => changed |= c,
            Err(e) => return Err(format!("ensure mcp.json entry failed: {e}")),
        }
        // ② adapter 残留清理
        match Self::cleanup_retired_adapter() {
            Ok(c) => changed |= c,
            Err(e) => log::warn!("[mcp-native] adapter cleanup deferred: {e}"),
        }
        Ok(if changed {
            "pi 原生 MCP 接入已就绪（jishu-hub 条目写入 + adapter 残留清理）".to_string()
        } else {
            "pi 原生 MCP 接入已就绪（无需变更）".to_string()
        })
    }

    /// mcp.json 键级 upsert jishu-hub 条目；返回是否有变更。
    fn upsert_native_hub_entry() -> Result<bool, String> {
        use serde_json::json;
        let path = crate::agent::jishu_self::paths::mcp_json_path().map_err(|e| e.to_string())?;
        let cli = crate::agent::jishu_self::resolve_jishu_cli_binary()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let desired = json!({
            "command": cli,
            "args": ["mcp", "serve"],
            // 需求11 追加四：pi 1.1.0 原生 MCP 默认 exposure=codemode（工具
            // 不进模型 schema——识图话术的 hub_mcp_list 无调用入口，P0 切换
            // 时漏验的可见性盲区）。toolExposure 放行两个代理工具为 direct：
            // hub_mcp_list（发现）/ hub_mcp_call（代理调用）进 schema，其余
            // 工具维持 codemode（不全量注入，context 增量最小）。
            "toolExposure": {
                "hub_mcp_list": "direct",
                "hub_mcp_call": "direct",
            },
        });
        let mut root: serde_json::Value = if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|c| serde_json::from_str(&c).ok())
                .unwrap_or_else(|| json!({"mcpServers": {}}))
        } else {
            json!({"mcpServers": {}})
        };
        if !root
            .get("mcpServers")
            .map(|v| v.is_object())
            .unwrap_or(false)
        {
            root["mcpServers"] = json!({});
        }
        let existing = root
            .get("mcpServers")
            .and_then(|s| s.get(crate::agent::mcp_server::HUB_MCP_ENTRY_NAME));
        // 需求11 追加四：就绪判定含 toolExposure——旧条目（无 direct 放行）
        // 须重写补齐（识图路径修复的存量迁移）；command 路径随安装位置变化
        // 不作比对（args 形态一致 + command 存在 + toolExposure 含两工具即就绪）。
        let tool_exposure_ok = existing
            .and_then(|e| e.get("toolExposure"))
            .and_then(|t| {
                Some(
                    t.get("hub_mcp_list").and_then(|v| v.as_str()) == Some("direct")
                        && t.get("hub_mcp_call").and_then(|v| v.as_str()) == Some("direct"),
                )
            })
            .unwrap_or(false);
        let matches = existing
            .and_then(|e| e.get("args"))
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>() == ["mcp", "serve"]
                    && existing
                        .and_then(|e| e.get("command"))
                        .and_then(|c| c.as_str())
                        .is_some_and(|c| !c.is_empty())
                    && tool_exposure_ok
            })
            .unwrap_or(false);
        if matches {
            return Ok(false);
        }
        root["mcpServers"][crate::agent::mcp_server::HUB_MCP_ENTRY_NAME] = desired;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        crate::util::atomic_write(
            &path,
            serde_json::to_string_pretty(&root).unwrap().as_bytes(),
        )
        .map_err(|e| e.to_string())?;
        log::info!(
            "[mcp-native] upserted jishu-hub entry in {}",
            path.display()
        );
        Ok(true)
    }

    /// 退役 adapter 残留清理：settings.json packages 数组摘 npm:pi-mcp-adapter*
    /// 条目 + 删 npm/node_modules/pi-mcp-adapter 目录。返回是否有变更。
    fn cleanup_retired_adapter() -> Result<bool, String> {
        let mut changed = false;
        let Some(agent_dir) = crate::agent::jishu_self::paths::agent_dir().ok() else {
            return Err("cannot resolve agent dir".to_string());
        };
        let settings_path = agent_dir.join("settings.json");
        if let Ok(content) = std::fs::read_to_string(&settings_path) {
            if let Ok(mut settings) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(pkgs) = settings.get_mut("packages").and_then(|v| v.as_array_mut()) {
                    let before = pkgs.len();
                    pkgs.retain(|v| {
                        !v.as_str()
                            .map(|s| {
                                s == "npm:pi-mcp-adapter" || s.starts_with("npm:pi-mcp-adapter@")
                            })
                            .unwrap_or(false)
                    });
                    if pkgs.len() != before {
                        crate::util::atomic_write(
                            &settings_path,
                            serde_json::to_string_pretty(&settings)
                                .unwrap_or_default()
                                .as_bytes(),
                        )
                        .map_err(|e| e.to_string())?;
                        changed = true;
                        log::info!("[mcp-native] removed retired adapter from settings packages");
                    }
                }
            }
        }
        let npm_dir = agent_dir
            .join("npm")
            .join("node_modules")
            .join("pi-mcp-adapter");
        if npm_dir.is_dir() {
            std::fs::remove_dir_all(&npm_dir).map_err(|e| format!("remove adapter dir: {e}"))?;
            changed = true;
            log::info!(
                "[mcp-native] removed retired adapter dir {}",
                npm_dir.display()
            );
        }
        Ok(changed)
    }

    /// v0.9.7 需求3 C2-②：市场安装通道复用（原仅启动自愈用，改 pub(crate)）。
    pub(crate) async fn run_pi_package_command(
        action: &str,
        source: &str,
    ) -> Result<String, String> {
        let runtime = pi_runtime::resolve_pi_runtime()
            .map_err(|e| format!("Failed to resolve Pi runtime: {e}"))?;

        let args = pi_package_args(&runtime.base_args, action, source);

        let mut cmd =
            crate::os_adapter::shell::shell_command(&runtime.program.to_string_lossy(), args);
        cmd.current_dir(std::env::current_dir().unwrap_or_default());

        #[cfg(target_os = "windows")]
        crate::process_command::tokio_no_window(&mut cmd);

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run pi {action} {source}: {e}"))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(format!(
                "pi {action} {source} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }

    /// v0.9.8 需求15-F2：在线扩展安装后的引擎启动自检探针。
    ///
    /// 背景（深挖轮更正，见需求15 04 方案）：`pi install` 退出 0 = 装包+
    /// 注册成功，但市场扩展常与内置包**工具名撞车**（如 rpiv-web-tools 与
    /// pi-web-access 都注册 web_search）——上游 pi 把装载诊断计入
    /// hasRuntimeErrors 直接 exit(1)，引擎每次 spawn 即崩（首跑 J11~J13
    /// 三连崩实例）。hub 侧此前只看退出码，无装后验证无回滚。
    ///
    /// 探针语义：以与真实会话同构的 `pi --mode rpc` 起一个最小实例并发
    /// `{"type":"get_state"}`——扩展装载完成引擎才会应答（与
    /// pi_rpc_runtime 连接循环握手同判定：`type=response &
    /// command=get_state`）；进程早退（stdout 关闭）= 装载期崩溃；限时
    /// 无应答 = 装载挂死。两条失败路径均判定「该安装毒化运行时」，由
    /// 调用方回滚卸载。
    ///
    /// 返回值（方案 A 终版）：`Ok(())` = 引擎健康；`Err(ProbeFailure)`
    /// = 自检失败——stderr 尾部随行带回，调用方据此区分「工具名冲突」
    ///（转通用冲突确认流，见 pi_registry：说明重叠→用户选择继续安装
    /// 则停用对手/取消则不装）与其他装载故障（回滚+报错）。
    pub(crate) async fn verify_engine_boot() -> Result<(), ProbeFailure> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        /// 自检限时：正常冷启动（含扩展装载）秒级完成；预连接池同类 spawn
        /// 为先例。60s 覆盖慢机冷启，仍远小于真实握手预算 150s。
        const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

        let runtime = pi_runtime::resolve_pi_runtime()
            .map_err(|e| ProbeFailure::new(format!("自检无法启动引擎（{e}）")))?;
        let mut args = runtime.base_args;
        args.push("--mode".to_string());
        args.push("rpc".to_string());

        let mut cmd =
            crate::os_adapter::shell::shell_command(&runtime.program.to_string_lossy(), args);
        // cwd 与真实会话同构（默认工作区）；不存在则退 temp（扩展装载读
        // 全局 agent 目录，cwd 只影响项目信任语义）。
        let cwd = crate::project::default_workspace_root();
        cmd.current_dir(if cwd.exists() {
            cwd
        } else {
            std::env::temp_dir()
        });
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        // 探针绝不常驻：任何路径漏杀时随 Child drop 兜底终止。
        cmd.kill_on_drop(true);
        #[cfg(target_os = "windows")]
        crate::process_command::tokio_no_window(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| ProbeFailure::new(format!("自检无法启动引擎（{e}）")))?;
        // stderr 排水兼采集（R2）：装载期警告写满管道缓冲会阻塞子进程
        // （Windows 4KB 起步），持续排水；同时保留尾部 4KB 供握手成功后
        // 提取「工具重叠」警告（full 取证仍走 pi_rpc_runtime 富化日志）。
        let stderr_tail: std::sync::Arc<std::sync::Mutex<String>> =
            std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut stderr = stderr;
                let mut sink = [0u8; 1024];
                loop {
                    match stderr.read(&mut sink).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut buf = tail.lock().unwrap_or_else(|e| e.into_inner());
                            buf.push_str(&String::from_utf8_lossy(&sink[..n]));
                            let len = buf.len();
                            if len > 4096 {
                                buf.drain(..len - 4096);
                            }
                        }
                    }
                }
            });
        }

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| ProbeFailure::new("自检无法接管引擎输入".to_string()))?;
        stdin
            .write_all(b"{\"type\":\"get_state\"}\n")
            .await
            .map_err(|e| ProbeFailure::new(format!("自检发送失败（进程可能已退出）：{e}")))?;
        stdin
            .flush()
            .await
            .map_err(|e| ProbeFailure::new(format!("自检发送失败：{e}")))?;
        drop(stdin);

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProbeFailure::new("自检无法接管引擎输出".to_string()))?;
        let mut reader = BufReader::new(stdout).lines();
        let deadline = tokio::time::Instant::now() + PROBE_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(ProbeFailure::with_stderr(
                    "引擎限时内未完成启动（扩展装载超时）",
                    stderr_tail
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone(),
                ));
            }
            match tokio::time::timeout(remaining, reader.next_line()).await {
                Ok(Ok(Some(line))) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    // 启动诊断行（非 JSON）跳过——同连接循环握手语义。
                    let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
                        continue;
                    };
                    let is_state_response = msg.get("type").and_then(|v| v.as_str())
                        == Some("response")
                        && msg.get("command").and_then(|v| v.as_str()) == Some("get_state");
                    if is_state_response {
                        return Ok(());
                    }
                }
                // stdout 关闭 = 进程已退出（装载期崩溃的典型形态）。
                Ok(Ok(None)) => {
                    // stdout 关闭 = 进程退出——带回 stderr 尾部供冲突识别
                    //（方案 A：工具撞名转确认流而非直接回滚报错）。
                    let tail = stderr_tail
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone();
                    return Err(ProbeFailure::with_stderr(
                        "引擎启动即退出（扩展装载失败）",
                        tail,
                    ));
                }
                Ok(Err(e)) => return Err(ProbeFailure::new(format!("自检读取失败：{e}"))),
                Err(_) => continue, // 步进到期，回环重算剩余预算
            }
        }
    }

    /// 需求15 方案 A v2（注册前预检，用户裁决：「装的时候判断扩展的工具
    /// 是否已经存在，而不是判断报错」）：npm 源专用。
    ///
    /// 流程（真实环境零注册写入——settings 全程不动）：
    /// 1. npm 装文件到共享池（`--prefix <agentDir>/npm`，与 pi install 同
    ///    参数语义；不写 settings 注册）；
    /// 2. `pi --mode rpc --no-session -e <池内入口>` 装载试运行——装载
    ///    全部已注册扩展 + 新包文件（-e 绝对路径），工具名冲突在装载期
    ///    即现形（pi 装载器权威判定）；
    /// 3. 分类：应答 = 无冲突；冲突行 = 涉新包的对手清单；其他失败 =
    ///    回滚文件 + Err。
    ///
    /// 返回：`Ok(None)` = 无冲突（文件已就位，调用方直接 `pi install`
    /// 幂等补注册）；`Ok(Some(pairs))` = 冲突（**文件保留**——确认后
    /// 复用；取消路径由调用方 `npm uninstall` 清理）；`Err` = 预检自身
    /// 失败（文件已回滚）。
    pub(crate) async fn precheck_extension(pkg: &str) -> Result<Option<Vec<ConflictPair>>, String> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        const PRECHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

        let Some(agent_dir) = pi_config_dir() else {
            return Err("无法定位 pi 运行数据目录".to_string());
        };
        let npm_root = std::path::Path::new(&agent_dir).join("npm");

        // 1) npm 装文件（不碰 settings）。参数对齐 pi installNpm（--prefix
        //    installRoot --legacy-peer-deps --no-audit --no-fund）；npm 程序
        //    裸调走 PATH——与 pi 自身解析同条件（pi 可装的环境此处亦可）。
        let mut npm = crate::os_adapter::shell::shell_command(
            "npm",
            vec![
                "install".to_string(),
                pkg.to_string(),
                "--prefix".to_string(),
                npm_root.to_string_lossy().to_string(),
                "--legacy-peer-deps".to_string(),
                "--no-audit".to_string(),
                "--no-fund".to_string(),
            ],
        );
        #[cfg(target_os = "windows")]
        crate::process_command::tokio_no_window(&mut npm);
        let npm_out = npm
            .output()
            .await
            .map_err(|e| format!("npm 不可用（{e}）——与插件安装同环境要求"))?;
        if !npm_out.status.success() {
            return Err(format!(
                "安装失败：{}",
                String::from_utf8_lossy(&npm_out.stderr).trim()
            ));
        }

        // 2) 探测包入口（package.json main → 常见形态回退）。
        let pkg_dir = npm_root.join("node_modules").join(pkg);
        let main_entry = std::fs::read_to_string(pkg_dir.join("package.json"))
            .ok()
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .and_then(|v| v.get("main").and_then(|m| m.as_str()).map(str::to_string));
        let mut candidates: Vec<String> = Vec::new();
        if let Some(m) = &main_entry {
            candidates.push(m.clone());
        }
        for c in ["index.ts", "index.js", "dist/index.js", "dist/index.mjs"] {
            candidates.push(c.to_string());
        }
        let entry = candidates
            .iter()
            .map(|c| pkg_dir.join(c))
            .find(|p| p.is_file())
            .ok_or_else(|| "包已下载但找不到扩展入口文件".to_string())?;

        // 3) 装载试运行（-e 绝对路径；--no-session 零写盘）。
        let runtime =
            pi_runtime::resolve_pi_runtime().map_err(|e| format!("预检无法启动引擎（{e}）"))?;
        let mut args = runtime.base_args;
        args.push("--mode".to_string());
        args.push("rpc".to_string());
        args.push("--no-session".to_string());
        args.push("-e".to_string());
        args.push(entry.to_string_lossy().to_string());
        let mut cmd =
            crate::os_adapter::shell::shell_command(&runtime.program.to_string_lossy(), args);
        let cwd = crate::project::default_workspace_root();
        cmd.current_dir(if cwd.exists() {
            cwd
        } else {
            std::env::temp_dir()
        });
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);
        #[cfg(target_os = "windows")]
        crate::process_command::tokio_no_window(&mut cmd);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("预检无法启动引擎（{e}）"))?;
        let stderr_tail: std::sync::Arc<std::sync::Mutex<String>> =
            std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut stderr = stderr;
                let mut sink = [0u8; 1024];
                loop {
                    match stderr.read(&mut sink).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut buf = tail.lock().unwrap_or_else(|e| e.into_inner());
                            buf.push_str(&String::from_utf8_lossy(&sink[..n]));
                            let len = buf.len();
                            if len > 4096 {
                                buf.drain(..len - 4096);
                            }
                        }
                    }
                }
            });
        }
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(b"{\"type\":\"get_state\"}\n")
                .await
                .map_err(|e| format!("预检发送失败：{e}"))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("预检发送失败：{e}"))?;
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "预检无法接管引擎输出".to_string())?;
        let mut reader = BufReader::new(stdout).lines();
        let deadline = tokio::time::Instant::now() + PRECHECK_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                Self::rollback_npm_files(pkg).await;
                return Err("预检超时（扩展装载未在限时内完成）".to_string());
            }
            match tokio::time::timeout(remaining, reader.next_line()).await {
                Ok(Ok(Some(line))) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
                        continue;
                    };
                    let answered = msg.get("type").and_then(|v| v.as_str()) == Some("response")
                        && msg.get("command").and_then(|v| v.as_str()) == Some("get_state");
                    if answered {
                        // 装载全量通过（含新包）——无冲突。
                        return Ok(None);
                    }
                }
                // 进程退出：冲突（装载失败）或其他致命错——读 stderr 分类。
                Ok(Ok(None)) | Ok(Err(_)) => {
                    let tail = stderr_tail
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone();
                    let pairs = extract_conflict_pairs(&tail);
                    let involved: Vec<ConflictPair> = pairs
                        .into_iter()
                        .filter(|p| p.self_pkg == pkg || p.opponent_pkg == pkg)
                        .collect();
                    if !involved.is_empty() {
                        // 冲突：文件保留（确认流复用；取消方清理）。
                        return Ok(Some(involved));
                    }
                    Self::rollback_npm_files(pkg).await;
                    return Err("预检失败：扩展无法装载（与工具名冲突无关）".to_string());
                }
                Err(_) => continue,
            }
        }
    }

    /// 预检回滚：从共享池卸载刚装的包文件（npm uninstall --prefix）。
    pub(crate) async fn rollback_npm_files(pkg: &str) {
        let Some(agent_dir) = pi_config_dir() else {
            return;
        };
        let mut npm = crate::os_adapter::shell::shell_command(
            "npm",
            vec![
                "uninstall".to_string(),
                pkg.to_string(),
                "--prefix".to_string(),
                std::path::Path::new(&agent_dir)
                    .join("npm")
                    .to_string_lossy()
                    .to_string(),
            ],
        );
        #[cfg(target_os = "windows")]
        crate::process_command::tokio_no_window(&mut npm);
        if let Err(e) = npm.output().await {
            log::warn!("[precheck] 回滚卸载 {pkg} 失败: {e}");
        }
    }

    /// v0.9.5 需求5：4 个 pi 扩展包逐个幂等安装（缺哪个装哪个；单包失败
    /// 记 warn 继续下一个，Err 汇总失败清单——启动自愈下轮重试，不阻断
    /// hub 启动）。探测与 mcp 同口径（node_modules 目录名含 scoped 包的
    /// @scope/ 层级）且**校验版本**：pi resolve 对「已注册但版本不匹配」
    /// 的包判 needsInstall，PI_OFFLINE 下静默跳过 → 扩展整个不装载——故
    /// 装了旧版本也必须重装到钉定版本。
    pub async fn ensure_pi_extensions_installed() -> Result<Vec<&'static str>, String> {
        let Some(base) = pi_config_dir() else {
            return Err("cannot resolve ~/.jishu-agent/agent directory".to_string());
        };
        let root = std::path::Path::new(&base).join("npm").join("node_modules");
        let mut installed: Vec<&'static str> = Vec::new();
        let mut failed: Vec<String> = Vec::new();
        for (source, dir_name, _display) in builtin_extensions() {
            let target = root.join(dir_name);
            // 第三轮评审修复：经 parse_npm_source 解析（rsplit 对 scoped
            // 无版本源会解出 "scope/pkg" 当版本——此处消费钉定源恒带版本，
            // 换 helper 防未来加无版本源时引爆同款）。
            let pinned_ver = parse_npm_source(source).1;
            let up_to_date = target.exists()
                && std::fs::read_to_string(target.join("package.json"))
                    .ok()
                    .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                    .and_then(|p| {
                        p.get("version")
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                    })
                    .is_some_and(|v| v == pinned_ver);
            if up_to_date {
                continue;
            }
            match Self::run_pi_package_command("install", source).await {
                Ok(_) => {
                    log::info!("[pi-ext] installed {source}");
                    installed.push(source);
                }
                Err(e) => {
                    log::warn!("[pi-ext] install {source} deferred: {e}");
                    failed.push(format!("{source}: {e}"));
                }
            }
        }
        if failed.is_empty() {
            Ok(installed)
        } else {
            Err(failed.join("; "))
        }
    }

    /// v0.9.5 需求5：npm 包名 → 钉定安装源——packages
    /// 注册同步（plugin::sync_pi_packages_with_plugins）复用同一真源。
    /// v0.9.5 需求11：pi-mcp-adapter 已退役（pi 1.1.0 原生 MCP），不再安装。
    pub(crate) fn pinned_source_for_package(name: &str) -> Option<&'static str> {
        builtin_extensions()
            .iter()
            .find(|(_, dir, _)| dir == name)
            .map(|(source, _, _)| source.as_str())
    }
}

pub(crate) fn pi_agent_dir() -> Option<String> {
    paths::agent_root()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

/// pi 运行数据目录（models.json/settings.json/sessions/extensions 等）。
/// pi 原生 getAgentDir() = ~/{piConfig.configDir}/agent = ~/.jishu-agent/agent。
/// hub 端读写 pi 数据必须用此路径与 pi 对齐（agent 本体仍用 pi_agent_dir）。
pub(crate) fn pi_config_dir() -> Option<String> {
    paths::agent_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

pub(crate) const JISHU_AGENT_IDENTITY_PROMPT: &str =
    "You are jishu agent, the built-in assistant inside Jishu Hub. \
You are not Pi. Use Pi's runtime, tools, and session engine invisibly, \
but present yourself as jishu agent. Reply naturally in the user's language. \
When replying in Chinese, your name is 「机枢 agent」(机枢); \
never transliterate jishu as 「极数」 or anything else. Before delegating via the subagent tool, always call it first with {\"action\":\"list\",\"capabilities\":true} and pick the agent strictly from the returned list — never guess agent names from prior habits. When you track work with the todo tool and multiple independent todos (no blockedBy between them) are pending, you may dispatch several subagent calls in the same turn to work on them in parallel instead of finishing them one by one. \
\
CAPABILITY DISCOVERY: When a user asks you to do something you cannot fulfill \
with your current tools alone, do NOT simply reply \"I can't\". Instead, follow \
this progressive discovery: \
(1) Check if an existing plugin already provides this capability (read \
jishu-hub-capabilities SKILL.md for the capability map). \
(2) If no existing capability matches, consider: can a PLUGIN be created to \
fulfill this? Jishu Hub's entire client is plugin-based — themes, chart \
renderers, panels, agents, tools, workflows are ALL plugins. Read \
jishu-plugin-authoring SKILL.md to understand what plugin forms exist and \
which template to use. \
(3) Create the plugin (copy the template, fill in specifics), install it via \
jishu-cli plugins add/add-hybrid, and tell the user to confirm in the hub GUI. \
This applies to ANY unfulfillable request: making PPTs, sending DingTalk \
requests, custom themes, new chart types, connecting new AI agents, building \
dashboards — if you can describe it, you can probably build it as a plugin.";

pub(crate) fn resolve_jishu_cli_binary() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("JISHU_CLI_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let exe = std::env::current_exe().map_err(|e| format!("Cannot determine current exe: {e}"))?;
    let parent = exe
        .parent()
        .ok_or_else(|| "No parent directory for current exe".to_string())?;

    #[cfg(target_os = "windows")]
    let binary_name = "jishu-cli.exe";

    #[cfg(not(target_os = "windows"))]
    let binary_name = "jishu-cli";

    let candidates = [
        parent.join(binary_name),
        parent.join("resources").join(binary_name),
        parent.join("..").join("resources").join(binary_name),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("release")
            .join(binary_name),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("debug")
            .join(binary_name),
    ];

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("jishu-cli binary not found: {binary_name}"))
}

use crate::agent::traits::{
    AgentManifest, ConfigAdapter, EventNormalizer, ProjectAdapter, SessionAdapter, TerminalAdapter,
    TransportAdapter,
};
// JISHU_AGENT_VERSION_START (auto-updated by upgrade-version.mjs)
pub const PI_AGENT_VERSION: &str = "1.5.0-15";
// JISHU_AGENT_VERSION_END

impl AgentManifest for JishuSelfAgent {
    fn config_dir(&self) -> Option<std::path::PathBuf> {
        crate::agent::jishu_self::paths::agent_dir().ok()
    }

    fn info(&self) -> AgentInfo {
        AgentInfo {
            id: "jishu-self".to_string(),
            display_name: "Jishu Agent".to_string(),
            version: PI_AGENT_VERSION.to_string(),
            icon: "jishu".to_string(),
            logo_path: Some("jishu.svg".to_string()),
            enabled: true,
        }
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::STREAM_TEXT_DELTA
            | AgentCapabilities::STREAM_TOOL_CALLS
            | AgentCapabilities::STDIN_PROMPT
            | AgentCapabilities::RESUME_BY_ID
            | AgentCapabilities::ABORT
            | AgentCapabilities::APPROVAL_REQUEST
            | AgentCapabilities::CONFIG_GLOBAL
            | AgentCapabilities::CONFIG_PROJECT
            | AgentCapabilities::IMAGE_INPUT
            | AgentCapabilities::FILE_INPUT
            | AgentCapabilities::TASK_PLANNING
            | AgentCapabilities::TASK_SUPERVISION
            // v0.7.4 需求1 B4：常规会话删除（Pi 会话 JSONL + 交互 sidecar）。
            | AgentCapabilities::SESSION_DELETE
            // v0.8.0 需求1 A5：会话分支（Pi 原生 clone RPC，从当前末尾复制整棵
            // 会话树；runtime 侧 AcpCommand::ForkSession 实现）。
            | AgentCapabilities::SESSION_FORK
            // v0.7.4 需求1 A3：手动 + 自动上下文压缩（Pi 原生 compact RPC）。
            | AgentCapabilities::CONTEXT_COMPACT
            // v0.7.4 需求3 M2：任务工作模式（任务图编排会话）。
            | AgentCapabilities::TASK_MODE
            // 评审 P2-⑤ 用户裁决：预连接池接管/补池对象改按能力位判定
            // （preconnect 经 registry 查此位，替代 agent id 硬编码分支）。
            | AgentCapabilities::PRECONNECTABLE
            // v0.8.0 需求1 P-2：逐次工具审批——fork 内置 jishu-tool-approval
            // 扩展经 beforeToolCall 阻塞/放行（APPROVAL_REQUEST 声明审批事件
            // 通道；PRE_EXECUTION_INTERCEPTION 自 v0.7.x 定义以来首次被真实
            // 声明）。
            | AgentCapabilities::APPROVAL_REQUEST
            | AgentCapabilities::PRE_EXECUTION_INTERCEPTION
    }

    fn is_builtin(&self) -> bool {
        // v0.7.4 需求3 M1：内建 agent——随 hub 分发/升级，环境检测置顶展示，
        // 并作为任务模式引擎。共享层按此标志分支，不写死 agent id。
        true
    }

    fn thinking_levels(&self) -> Vec<String> {
        // Pi 全集七档（EXTENDED_THINKING_LEVELS）；Pi 按当前模型 clamp 并
        // 经 thinking_level_changed 事件回传生效值（v0.7.4 需求1 A7）。
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    fn probe_sync(&self) -> crate::agent::capability::AgentHealth {
        probe::probe_self()
    }

    fn auto_installed(&self) -> bool {
        false
    }

    fn native_install_command(&self) -> Option<String> {
        Some("jishu-hub-internal-install".to_string())
    }

    fn available_version(&self) -> Option<String> {
        Some(PI_AGENT_VERSION.to_string())
    }

    fn install_package_manager(&self) -> Option<String> {
        Some("Jishu Hub 内置 Node 环境".to_string())
    }
}

impl ProjectAdapter for JishuSelfAgent {
    fn scan_projects(&self) -> Vec<crate::project::Project> {
        pi_session::scan_pi_projects()
    }

    fn add_project(&self, path: &str) -> Option<crate::project::Project> {
        let project_path = std::path::Path::new(path);
        if !project_path.is_dir() {
            return None;
        }
        // Ensure the session directory exists to "register" the project
        if let Ok(session_dir) = pi_session::pi_session_dir(path) {
            let _ = std::fs::create_dir_all(&session_dir);
        }
        crate::project::project_from_agent_path(path, "jishu-self", 0, None)
    }

    fn decode_project_path(&self, encoded: &str) -> String {
        crate::project::decode_project_path(encoded)
    }

    fn encode_project_path(&self, path: &str) -> String {
        crate::project::encode_project_path(path)
    }

    fn get_level1_dir(&self, path: &str) -> Option<String> {
        crate::project::get_level1_dir(path)
    }

    fn project_settings_surface(&self) -> crate::agent::ProjectSettingsSurface {
        // v0.7.4 项目配置适配 + v0.7.5 路径修正：Pi 原生项目级设置
        // <project>/.jishu-agent/settings.json（fork configDir；深合并覆盖全局）。
        // 真实字段为 defaultModel / defaultThinkingLevel / compaction；
        // permissions/env/hooks 不在 Pi Settings schema 中（不声明即不渲染）。
        crate::agent::ProjectSettingsSurface::Supported {
            scopes: vec![crate::agent::ProjectSettingsScope::Shared],
            access_modes: Vec::new(),
            fields: vec![
                "model".to_string(),
                "thinking_level".to_string(),
                "compaction".to_string(),
            ],
        }
    }

    fn load_project_settings(&self, path: &str) -> Result<ProjectSettings, String> {
        // Pi 原生项目设置 .jishu-agent/settings.json（v0.7.4 项目配置适配：
        // 此前误用 claude 的 .claude/settings.json 读写；v0.7.5 修正目录名
        // ——fork configDir 为 .jishu-agent 而非上游 .pi，不留兼容）。
        // 仅映射真实存在的字段：
        // defaultModel → model、defaultThinkingLevel → thinkingLevel。
        let raw = config::load_pi_project_settings_raw(path).map_err(|e| e.to_string())?;
        // Pi 按 (defaultProvider, defaultModel) 二元组解析——拼回 "provider/model"。
        let model = match (
            raw.get("defaultProvider").and_then(|v| v.as_str()),
            raw.get("defaultModel").and_then(|v| v.as_str()),
        ) {
            (Some(p), Some(m)) if !m.is_empty() => Some(format!("{p}/{m}")),
            _ => None,
        };
        let compaction = raw
            .get("compaction")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok());
        Ok(ProjectSettings {
            permissions: None,
            hooks: None,
            env: None,
            model,
            thinking_level: raw
                .get("defaultThinkingLevel")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            compaction,
        })
    }

    fn load_project_settings_local(&self, _path: &str) -> Result<ProjectSettings, String> {
        // Pi 项目设置只有 shared 一档（无 settings.local.json）。
        Err(
            "Pi project settings support only the shared scope (.jishu-agent/settings.json)"
                .to_string(),
        )
    }

    fn save_project_settings(&self, path: &str, settings: &ProjectSettings) -> Result<(), String> {
        config::save_pi_project_settings_fields(
            path,
            settings.model.as_deref(),
            settings.thinking_level.as_deref(),
            settings.compaction.as_ref(),
        )
        .map_err(|e| e.to_string())
    }

    fn save_project_settings_local(
        &self,
        _path: &str,
        _settings: &ProjectSettings,
    ) -> Result<(), String> {
        Err(
            "Pi project settings support only the shared scope (.jishu-agent/settings.json)"
                .to_string(),
        )
    }

    fn load_claude_md(&self, path: &str) -> Result<Option<String>, String> {
        crate::project_config::load_claude_md(path).map_err(|e| e.to_string())
    }

    fn init_project(&self, project_path: &str) -> Result<bool, String> {
        let md_path = PathBuf::from(project_path).join("CLAUDE.md");
        if md_path.exists() {
            Ok(false)
        } else {
            std::fs::write(&md_path, "# Project Instructions\n\n").map_err(|e| e.to_string())?;
            Ok(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jishu_agent_disables_user_message_session_injection() {
        // session_id 改由 session-context 扩展注入 system prompt，user message 注入下线。
        assert!(JishuSelfAgent::new()
            .resolved_session_prompt_injection()
            .is_none());
    }
}

impl SessionAdapter for JishuSelfAgent {
    fn list_sessions(&self, encoded_name: &str) -> Result<Vec<crate::session::Session>, String> {
        pi_session::list_pi_sessions(encoded_name)
    }

    fn get_session_messages(
        &self,
        session_id: &str,
        encoded_name: &str,
    ) -> Result<Vec<crate::session::Message>, String> {
        pi_session::load_pi_session_messages(session_id, encoded_name)
    }

    fn persist_interaction_blocks(
        &self,
        _session_path: Option<&str>,
        session_id: Option<&str>,
        _encoded_name: Option<&str>,
        interactions: Vec<serde_json::Value>,
    ) -> Result<(), String> {
        let session_id = session_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Pi interaction persistence requires a session id".to_string())?;
        pi_session::persist_pi_interaction_blocks(session_id, interactions)
    }

    fn load_history(&self) -> Vec<crate::history::HistoryEntry> {
        Vec::new()
    }

    fn delete_session(&self, session_id: &str, encoded_name: &str) -> Result<(), String> {
        pi_session::delete_pi_session(session_id, encoded_name)
    }
}

impl ConfigAdapter for JishuSelfAgent {
    fn permission_modes(&self) -> Option<(Vec<String>, crate::agent::PermissionModeProvider)> {
        // P-1：工具模式由 Hub 全局管理；readonly 在 PiRpc spawn 时落 --tools 白名单
        // （read,grep,find,ls —— pi 内置工具全集去掉 bash/edit/write）。
        // v0.8.0 需求1 P-2 收尾（用户裁决融入会话工具模式）：新增 full-approve
        // 档 = full 工具集 + 逐次审批（toolApproval=smart 写 Pi settings），
        // 与完整/只读同列选择；full 档写 toolApproval=off（原行为）。
        Some((
            vec![
                "full".to_string(),
                "full-approve".to_string(),
                "smart-approve".to_string(),
                "readonly".to_string(),
            ],
            crate::agent::PermissionModeProvider::HubToolMode,
        ))
    }

    fn config_surface(&self) -> crate::agent::ConfigSurface {
        crate::agent::ConfigSurface::ModelStore {
            provider: "pi".to_string(),
            supports_picker: true,
            supports_mcp: true,
        }
    }

    fn load_config(&self) -> Result<serde_json::Value, String> {
        config::load_jishu_config().map_err(|e| e.to_string())
    }

    fn save_config(&self, value: &serde_json::Value) -> Result<(), String> {
        config::save_jishu_config(value).map_err(|e| e.to_string())
    }

    fn config_templates(&self) -> Vec<crate::hub::ConfigTemplate> {
        // v0.7.5 需求6：模版按使用场景区分（模型 + 行为与权限全量），全部
        // requires_fill + model_store_patch——应用时选服务商预设/填密钥/勾模型，
        // 渠道合并写 models.json（现有渠道保留），行为字段写 settings.json。
        // 旧的三个纯思考档位模版（R15 产物，单键无法形成可用配置）已移除。
        vec![
            crate::hub::ConfigTemplate {
                requires_fill: true,
                id: "jishu-daily-dev".into(),
                name: "日常开发".into(),
                description: "日常编码与迭代的均衡配置：高档思考、默认工具集（读写/终端/编辑）、\
                              标准自动重试、常规上下文压缩。适合大多数开发任务，速度与质量平衡。"
                    .into(),
                config: serde_json::json!({
                    "defaultThinkingLevel": "high",
                    "compaction": { "enabled": true, "thresholdPercent": 95, "keepRecentTokens": 20000 },
                    "defaultTools": template_default_tools(&[]),
                    "retry": { "enabled": true, "maxRetries": 10, "baseDelayMs": 2000 }
                }),
                model_store_patch: Some(serde_json::json!({ "providers": {} })),
            },
            crate::hub::ConfigTemplate {
                requires_fill: true,
                id: "jishu-deep-dive".into(),
                name: "深度攻坚".into(),
                description:
                    "疑难问题与大型重构：最大档思考、全部内置工具（含内容搜索/文件查找/列目录）、\
                              更强重试与更大上下文保留，长会话不丢关键信息。耗时与 token 消耗最高。"
                        .into(),
                config: serde_json::json!({
                    "defaultThinkingLevel": "max",
                    "compaction": { "enabled": true, "thresholdPercent": 95, "keepRecentTokens": 40000 },
                    "defaultTools": template_default_tools(&["grep", "find", "ls"]),
                    "retry": { "enabled": true, "maxRetries": 10, "baseDelayMs": 2000 }
                }),
                model_store_patch: Some(serde_json::json!({ "providers": {} })),
            },
            crate::hub::ConfigTemplate {
                requires_fill: true,
                id: "jishu-quick-qa".into(),
                name: "快速问答".into(),
                description: "简单问题与轻量任务：低档思考几乎即问即答、默认工具集、标准重试。\
                              响应最快、消耗最低，适合答疑、查询、小改动确认。"
                    .into(),
                config: serde_json::json!({
                    "defaultThinkingLevel": "low",
                    "compaction": { "enabled": true, "thresholdPercent": 95, "keepRecentTokens": 20000 },
                    "defaultTools": template_default_tools(&[]),
                    "retry": { "enabled": true, "maxRetries": 10, "baseDelayMs": 2000 }
                }),
                model_store_patch: Some(serde_json::json!({ "providers": {} })),
            },
        ]
    }
    fn as_raw_config(&self) -> Option<&dyn crate::agent::config_roles::RawConfigStore> {
        Some(self)
    }

    fn as_backup_store(&self) -> Option<&dyn crate::agent::config_roles::ConfigBackupStore> {
        Some(self)
    }

    fn as_model_store(&self) -> Option<&dyn crate::agent::config_roles::ModelStore> {
        Some(self)
    }

    fn as_mcp(&self) -> Option<&dyn crate::agent::config_roles::McpIntegration> {
        Some(self)
    }
}

impl crate::agent::config_roles::RawConfigStore for JishuSelfAgent {
    fn config_format(&self) -> Option<String> {
        Some("json".to_string())
    }

    fn load_raw_config(&self) -> Result<String, String> {
        config::load_raw_jishu_config().map_err(|e| e.to_string())
    }

    fn save_raw_config(&self, content: &str) -> Result<(), String> {
        config::save_raw_jishu_config(content).map_err(|e| e.to_string())
    }
}

impl crate::agent::config_roles::ConfigBackupStore for JishuSelfAgent {
    fn list_backups(&self) -> Result<Vec<crate::config::BackupEntry>, String> {
        config::list_jishu_backups().map_err(|e| e.to_string())
    }

    fn restore_backup(&self, path: &str) -> Result<(), String> {
        config::restore_jishu_backup(path).map_err(|e| e.to_string())
    }

    fn export_config(&self, path: &str) -> Result<(), String> {
        config::export_jishu_config(path).map_err(|e| e.to_string())
    }

    fn import_config(&self, path: &str) -> Result<serde_json::Value, String> {
        config::import_jishu_config(path).map_err(|e| e.to_string())
    }
}

impl crate::agent::config_roles::ModelStore for JishuSelfAgent {
    fn load_model_store(&self) -> Result<serde_json::Value, String> {
        let config = pi_models_config::load()?;
        serde_json::to_value(&config).map_err(|e| format!("Cannot serialize models config: {e}"))
    }

    fn save_model_store(&self, config: &serde_json::Value) -> Result<(), String> {
        let parsed: pi_models_config::PiModelsConfig = serde_json::from_value(config.clone())
            .map_err(|e| format!("Invalid models config payload: {e}"))?;
        pi_models_config::save(&parsed)
    }

    fn get_active_model(&self) -> Result<Option<serde_json::Value>, String> {
        let active = jishu_settings::get_active()?;
        Ok(active.map(|a| serde_json::to_value(a).unwrap_or_default()))
    }

    fn set_active_model(&self, active: Option<&serde_json::Value>) -> Result<(), String> {
        let parsed: Option<jishu_settings::ActiveModel> = active
            .map(|v| {
                serde_json::from_value(v.clone()).map_err(|e| format!("Invalid active model: {e}"))
            })
            .transpose()?;
        jishu_settings::set_active(parsed)
    }

    // ── MCP adapter methods ──
}

impl crate::agent::config_roles::McpIntegration for JishuSelfAgent {
    fn check_mcp(&self) -> Result<serde_json::Value, String> {
        // v0.9.5 需求11（pi 1.1.0）：adapter 退役后检查 = pi 原生 mcp.json 的
        // jishu-hub 条目 + adapter 残留状态（残留会压制 builtin:mcp，须清理）。
        let entry_ok = crate::agent::jishu_self::paths::mcp_json_path()
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .and_then(|root| {
                root.get("mcpServers")?
                    .get(crate::agent::mcp_server::HUB_MCP_ENTRY_NAME)?
                    .get("args")?
                    .as_array()
                    .map(|a| {
                        a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>() == ["mcp", "serve"]
                    })
            })
            .unwrap_or(false);
        let adapter_residual = Self::mcp_adapter_dir().map(|d| d.exists()).unwrap_or(false);
        Ok(serde_json::json!({
            "native": entry_ok,
            "adapter_residual": adapter_residual,
            // 兼容旧 UI 字段：installed 语义 = 原生接入就绪
            "installed": entry_ok && !adapter_residual,
            "version": null,
        }))
    }

    fn install_mcp(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>
    {
        Box::pin(async { Self::install_mcp_standalone().await })
    }

    fn update_mcp(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>
    {
        // v0.9.5 需求11：adapter 退役后无包可更新——update 复用 ensure 幂等
        // （条目/残留状态归位）。
        Box::pin(async { Self::ensure_native_mcp_entry().await })
    }

    fn migrate_mcp_if_needed(&self) {
        let Ok(value) = config::load_jishu_config() else {
            return;
        };
        let Ok(typed) = serde_json::from_value::<config::JishuConfig>(value) else {
            return;
        };
        let _ = config::sync_mcp_json(&typed);
    }
}

/// v0.9.1 需求3 #3：配置模板的 defaultTools 集合——基础集 + 场景附加项，
/// Windows 下追加 pi 可选原生 powershell 工具（与 bash 并存，pi
/// docs/windows.md 的对比用法；`!`/`!!` 编辑器命令仍走 bash）。编译期平台
/// 隔离，非 Windows 产物不含该工具名。
fn template_default_tools(extra: &[&'static str]) -> Vec<&'static str> {
    let mut tools: Vec<&'static str> = vec![
        "read",
        "bash",
        "edit",
        "write",
        // v0.9.7 需求2（R1 生产实测 issue #4）：任务执行器（jishu-task-runner
        // 扩展）registerTool 注册的三工具——pi 的 --tools 是硬白名单，不进
        // 名单则 agent 不可见（实测复现）。runner 是任务模式底座，与
        // read/bash 同级常驻，不挂任何插件 toml 声明（task-plan 需求3 后
        // 可能未物化，不能依赖它）。白名单例外条款见 DEVELOP_READ §16.4a
        //（评审成文）。
        "update_steps",
        "ask_user",
        "dispatch_to_node",
    ];
    tools.extend_from_slice(extra);
    if cfg!(windows) {
        tools.push("powershell");
    }
    tools
}

/// v0.9.8 需求10-③ P1 修复：把 plugin-invoke 物化的 [[agent-tool]] 工具名
/// 并入 spawn 白名单基集。pi 的 `--tools` 是硬白名单——不进名单的扩展
/// 工具 agent 不可见（v0.9.7 需求2 issue #4 同型坑：当时修了 task-runner
/// 三工具但漏了本通道，[[agent-tool]] 物化通道自 v0.9.5 引入起在任何 pi
/// 版本下都不可见，v0.9.8 装入首个声明件后现形）。去重合并，纯函数可单测。
fn merge_agent_tool_names(mut base: Vec<String>) -> Vec<String> {
    for entry in crate::agent::plugin::load_agent_tools() {
        if !base.iter().any(|n| n == &entry.name) {
            base.push(entry.name);
        }
    }
    base
}

/// v0.9.1 需求13：settings 未配置 defaultTools 时向 spawn 参数追加
/// `--tools <全集>`（Windows 含 powershell）。纯函数可单测。
fn ensure_default_tools_arg(
    args: &mut Vec<String>,
    cfg: &Result<serde_json::Value, Box<dyn std::error::Error>>,
    pi_extension_tools: &[String],
) {
    // v0.9.2 需求7：扩展工具按"插件已启用"聚合注入（热插拔闸门，见
    // plugin::enabled_pi_extension_tools）。pi 的 --tools 是硬白名单——不在
    // 名单的扩展工具连 conductor 阶段 setActiveTools 也救不回（测试期实证），
    // 故必须显式进名单。
    let unset = cfg
        .as_ref()
        .ok()
        .map(|c| c.get("defaultTools").is_none())
        .unwrap_or(true);
    if unset {
        let mut tools: Vec<String> = template_default_tools(&[])
            .iter()
            .map(|s| s.to_string())
            .collect();
        tools.extend_from_slice(pi_extension_tools);
        // 需求11 追加四三轮：追加 MCP 通配模式——pi 1.1.0 的 --tools 绝对
        // 名单会把 direct 暴露的 MCP 工具滤出 schema（实测复现：名单无此
        // 模式时模型无 mcp__ 工具）；mcp__* 通配只放行已 direct 的工具
        //（codemode 的不进 schema），随 toolExposure 配置自适应。
        tools.push("mcp__*".to_string());
        args.push("--tools".to_string());
        args.push(tools.join(","));
        return;
    }
    // 已配置 defaultTools 的用户：配置清单原样生效，仅追加已启用扩展工具。
    if let Some(list) = cfg
        .as_ref()
        .ok()
        .and_then(|c| c.get("defaultTools"))
        .and_then(|v| v.as_array())
    {
        let mut names: Vec<String> = list
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        for tool in pi_extension_tools {
            if !names.iter().any(|n| n == tool) {
                names.push(tool.to_string());
            }
        }
        // v0.9.7 需求2（issue #4）：已配置路径同样保证 runner 三工具在场
        //（底座能力不依赖用户配置清单）。
        for tool in ["update_steps", "ask_user", "dispatch_to_node"] {
            if !names.iter().any(|n| n == tool) {
                names.push(tool.to_string());
            }
        }
        // 同上（需求11 追加四三轮）：已配置清单同样追加 MCP 通配。
        if !names.iter().any(|n| n == "mcp__*") {
            names.push("mcp__*".to_string());
        }
        args.push("--tools".to_string());
        args.push(names.join(","));
    }
}

/// （v0.9.5 需求11 退役留痕）pi-mcp-adapter 最后钉定源——pi 1.1.0 原生
/// MCP client 落地后 adapter 扩展退役（D0 开源优先：上游原生覆盖桥接层；
/// 其 /mcp 命令会压制 pi 内置 builtin:mcp）。仅存留作历史参考与测试
/// 断言素材，不再用于安装/更新；残留清理见 ensure_native_mcp_entry。
#[allow(dead_code)] // 仅测试模块引用（退役留痕，非生产路径）
pub(crate) const MCP_ADAPTER_SOURCE: &str = "npm:pi-mcp-adapter@2.32.1";

/// 解析 npm 源串（`npm:<pkg>[@<version>]`）→ (包名, 版本)。
/// v0.9.7 第三轮评审修复：scoped 包（@scope/pkg）首 @ 是名字一部分——
/// 直接 rsplit_once 会把「scoped 无版本源」唯一的 @ 当版本分隔，解出
/// 包名空串、版本="scope/pkg"（builtin_pins 显示乱码版本 + 启动自愈
/// 永判版本不符反复重装）。解析规则：scoped 跳过首 @ 与 scope 段，其后
/// 第一个 @ 才是版本分隔；非 scoped 从右取 @ 且两端非空才视为带版本。
pub(crate) fn parse_npm_source(source: &str) -> (String, String) {
    let body = source.strip_prefix("npm:").unwrap_or(source);
    if let Some(rest) = body.strip_prefix('@') {
        // scoped：rest = "scope/pkg[@ver]"——首个 @ 之后才是版本
        return match rest.find('@') {
            Some(i) => {
                let split = i + 1; // 含首 @ 的包名长度
                (body[..split].to_string(), body[split + 1..].to_string())
            }
            None => (body.to_string(), String::new()),
        };
    }
    match body.rsplit_once('@') {
        Some((n, v)) if !n.is_empty() && !v.is_empty() => (n.to_string(), v.to_string()),
        _ => (body.to_string(), String::new()),
    }
}

/// v0.9.5 需求5：随包初始化安装的 pi 扩展（钉定版本，与 mcp 同策略——
/// 可预测、离线可复现）。**D4-8（2026-11-21 用户裁决）数据结构化**：
/// 硬编码常量退役，改为打包数据 resources/extensions/builtin.json
/// （include_str 编译期单源）——内置与用户装在 extensions.db 同构
/// （builtin 仅标记列）。元素 = (npm 安装源, node_modules 目录名, 展示名)。
pub(crate) fn builtin_extensions() -> &'static Vec<(String, String, String)> {
    static CACHE: std::sync::OnceLock<Vec<(String, String, String)>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        #[derive(serde::Deserialize)]
        struct Entry {
            source: String,
            dir: String,
            display: String,
        }
        let raw = include_str!("../../../resources/extensions/builtin.json");
        match serde_json::from_str::<Vec<Entry>>(raw) {
            Ok(list) => list
                .into_iter()
                .map(|e| (e.source, e.dir, e.display))
                .collect(),
            // 打包资源损坏属构建事故：fail-loud 日志（不 panic 阻断启动——
            // ensure 会跳过安装并在日志暴露），单测锁解析完整性。
            Err(e) => {
                log::error!("[builtin-extensions] builtin.json 解析失败: {e}");
                Vec::new()
            }
        }
    })
}

/// 内置扩展展示名（包目录名 → 数据查询；替代原 match 表）。
/// 内置扩展的预置适配关系（builtin.json preset_adapters——R2 用户裁决：
/// rpiv-todo 有任务看板 GUI，应在数据层建立关系）。
pub(crate) fn builtin_preset_adapters() -> &'static Vec<(String, Vec<String>)> {
    static CACHE: std::sync::OnceLock<Vec<(String, Vec<String>)>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        #[derive(serde::Deserialize)]
        struct Entry {
            dir: String,
            #[serde(default)]
            preset_adapters: Option<Vec<String>>,
        }
        let raw = include_str!("../../../resources/extensions/builtin.json");
        serde_json::from_str::<Vec<Entry>>(raw)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| {
                e.preset_adapters
                    .filter(|a| !a.is_empty())
                    .map(|a| (format!("npm:{}", e.dir), a))
            })
            .collect()
    })
}

pub(crate) fn builtin_pi_display_name_of(dir_name: &str) -> Option<String> {
    builtin_extensions()
        .iter()
        .find(|(_, dir, _)| dir == dir_name)
        .map(|(_, _, display)| display.clone())
}

/// 内置扩展的 GUI 判定预置（builtin.json 的 gui_verdict/verdict_note——
/// 用户裁决「内置=预置的」）：逐件判定（R2 用户裁决修正 2026-11-21：
/// 一刀切 noneeded 是错的——todo 有任务看板 GUI；ask-user/lens/web-access
/// 结果在会话内呈现；仅 subagents 真后台）。用户可经 `extensions verdict
/// <pkg> pending` 或界面「重新判定」改判——**只在仍为 pending 时落预置，
/// 不覆盖用户改判**。
pub(crate) fn builtin_gui_verdicts() -> &'static Vec<(String, String, String)> {
    static CACHE: std::sync::OnceLock<Vec<(String, String, String)>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        #[derive(serde::Deserialize)]
        struct Entry {
            dir: String,
            #[serde(default)]
            gui_verdict: Option<String>,
            #[serde(default)]
            verdict_note: Option<String>,
        }
        let raw = include_str!("../../../resources/extensions/builtin.json");
        serde_json::from_str::<Vec<Entry>>(raw)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| {
                // noneeded | session（会话内呈现）| adapted（有预置适配件）
                e.gui_verdict
                    .filter(|v| v == "noneeded" || v == "session" || v == "adapted")
                    .map(|v| {
                        (
                            format!("npm:{}", e.dir),
                            v,
                            e.verdict_note.unwrap_or_default(),
                        )
                    })
            })
            .collect()
    })
}

/// 需求15 方案 A：探针失败结构——reason 为用户文案；stderr_tail 供调用方
/// 区分「工具名冲突」（转确认流）与其他装载故障（回滚+报错）。
pub(crate) struct ProbeFailure {
    pub reason: String,
    pub stderr_tail: String,
}

impl ProbeFailure {
    fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            stderr_tail: String::new(),
        }
    }
    fn with_stderr(reason: impl Into<String>, stderr_tail: String) -> Self {
        Self {
            reason: reason.into(),
            stderr_tail,
        }
    }
}

/// 需求15 方案 A v2：一条工具冲突（诊断行 `Failed to load extension
/// "<A 路径>": Tool "x" conflicts with <B 路径>` 的结构化产物）。
/// 注意 A/B 方向不定（装载顺序决定谁先占名）——调用方按「哪方是预检
/// 目标包」分辨对手。
#[derive(Debug)]
pub(crate) struct ConflictPair {
    pub tool: String,
    /// 「装载失败方」包目录名（诊断行第一个引号路径）。
    pub self_pkg: String,
    /// 冲突对手包目录名（conflicts with 之后的路径）。
    pub opponent_pkg: String,
}

/// 路径文本 → node_modules 段后的包目录名（scoped 取 @scope/name 两段；
/// 分隔符归一为斜杠）。纯函数。
pub(crate) fn pkg_dir_from_path(path_text: &str) -> Option<String> {
    let nm = path_text.rfind("node_modules")?;
    let rest = path_text[nm + "node_modules".len()..].trim_start_matches(['\\', '/']);
    let mut end = rest.find(['\\', '/']).unwrap_or(rest.len());
    if rest[..end].starts_with('@') {
        if let Some(sep) = rest[end..].find(['\\', '/']) {
            let second_rel = end + sep + 1;
            let second_end = second_rel
                + rest[second_rel..]
                    .find(['\\', '/'])
                    .unwrap_or(rest.len() - second_rel);
            end = second_end;
        }
    }
    let name = &rest[..end];
    (!name.is_empty()).then(|| name.replace('\\', "/"))
}

/// 需求15 方案 A v2（通用冲突治理）：从预检 stderr 解析全部「工具名
/// 冲突」对（双向：self/opponent 均为包目录名）。同工具同对去重。
/// 纯函数可单测。
pub(crate) fn extract_conflict_pairs(stderr_tail: &str) -> Vec<ConflictPair> {
    let mut out: Vec<ConflictPair> = Vec::new();
    for line in stderr_tail.lines() {
        let Some(idx) = line.find("conflicts with") else {
            continue;
        };
        let head = &line[..idx];
        // 工具名：head 最后一个引号对。
        let tool = (|| {
            let q = head.rfind('"')?;
            let start = head[..q].rfind('"')?;
            let name = &head[start + 1..q];
            (!name.is_empty()).then(|| name.to_string())
        })();
        // 失败方：head 第一个引号对（自身路径）。
        let self_pkg = (|| {
            let start = head.find('"')?;
            let q = head[start + 1..].find('"')? + start + 1;
            pkg_dir_from_path(&head[start + 1..q])
        })();
        // 对手：冲突词之后路径。
        let tail = &line[idx + "conflicts with".len()..];
        let opponent_pkg = pkg_dir_from_path(tail);
        if let (Some(tool), Some(self_pkg), Some(opponent_pkg)) = (tool, self_pkg, opponent_pkg) {
            if !out
                .iter()
                .any(|c| c.tool == tool && c.self_pkg == self_pkg && c.opponent_pkg == opponent_pkg)
            {
                out.push(ConflictPair {
                    tool,
                    self_pkg,
                    opponent_pkg,
                });
            }
        }
    }
    out
}

/// pi 包管理命令行参数（install/update <source>）——mcp 与 4 扩展共用。
fn pi_package_args(base_args: &[String], action: &str, source: &str) -> Vec<String> {
    let mut args = base_args.to_vec();
    args.push(action.to_string());
    args.push(source.to_string());
    args
}

/// v0.9.1 需求12 补充：从 settings.json Value 提取 hubSpawnEnv 环境变量
/// 覆盖（键值均须字符串；空值合法——如 PI_OFFLINE="" 置空关闭）。纯函数
/// 可单测。
fn spawn_env_overrides(
    cfg: &Result<serde_json::Value, Box<dyn std::error::Error>>,
) -> Vec<(String, String)> {
    let Ok(v) = cfg else {
        return Vec::new();
    };
    v.get("hubSpawnEnv")
        .and_then(|m| m.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod mcp_tests {
    use super::{builtin_extensions, pi_package_args};

    /// v0.9.1 需求13：未配置 defaultTools → 追加 --tools 全集；已配置 → 不动。
    #[test]
    fn default_tools_spawn_arg_only_when_unset() {
        use serde_json::json;
        let mut args = vec!["--mode".to_string(), "rpc".to_string()];
        let ext = vec![
            "request_user_input".to_string(),
            "lock_requirement".to_string(),
        ];
        super::ensure_default_tools_arg(&mut args, &Ok(json!({})), &ext);
        assert_eq!(args[2], "--tools");
        assert!(args[3].starts_with("read,bash,edit,write"));
        // v0.9.2 需求7：聚合的扩展工具随默认集注入（热插拔闸门的下游）
        for tool in &ext {
            assert!(args[3].split(',').any(|t| t == tool), "missing {tool}");
        }
        // v0.9.7 需求2（issue #4）：runner 三工具底座常驻（两条路径都在场）
        for tool in ["update_steps", "ask_user", "dispatch_to_node"] {
            assert!(args[3].split(',').any(|t| t == tool), "missing {tool}");
        }

        let mut args2 = vec!["--mode".to_string(), "rpc".to_string()];
        super::ensure_default_tools_arg(&mut args2, &Ok(json!({"defaultTools": ["read"]})), &ext);
        // 已配置清单照常生效，追加已启用扩展工具 + runner 底座三工具 + MCP 通配
        assert_eq!(
            args2[3],
            "read,request_user_input,lock_requirement,update_steps,ask_user,dispatch_to_node,mcp__*"
        );

        let mut args3 = vec![];
        super::ensure_default_tools_arg(&mut args3, &Err("io".into()), &ext);
        assert_eq!(args3.len(), 2, "读失败按未配置处理");
    }

    /// v0.9.1 需求12 补充：hubSpawnEnv 提取——字符串键值对；非字符串值跳过；
    /// 空值合法（置空覆盖）；缺键/读失败 → 空。
    #[test]
    fn spawn_env_overrides_extracts_string_pairs() {
        use serde_json::json;
        let cfg = Ok(json!({
            "defaultThinkingLevel": "high",
            "hubSpawnEnv": {
                "HTTP_PROXY": "http://127.0.0.1:7890",
                "PI_OFFLINE": "",
                "BAD": 123,
            }
        }));
        let mut envs = super::spawn_env_overrides(&cfg);
        envs.sort();
        assert_eq!(
            envs,
            vec![
                (
                    "HTTP_PROXY".to_string(),
                    "http://127.0.0.1:7890".to_string()
                ),
                ("PI_OFFLINE".to_string(), String::new()),
            ]
        );
        // 无键 / Err → 空。
        assert!(super::spawn_env_overrides(&Ok(json!({}))).is_empty());
        assert!(super::spawn_env_overrides(&Err("io".into())).is_empty());
    }

    #[test]
    fn mcp_update_uses_pi_single_package_update_command() {
        // （历史断言保留）退役前 adapter 包命令构造；退役后此参数构造仍被
        // 其余 4 个 pi 扩展包的 update 路径复用（ensure_pi_extensions_installed）。
        assert_eq!(
            pi_package_args(&["cli.js".to_string()], "update", super::MCP_ADAPTER_SOURCE),
            vec!["cli.js", "update", "npm:pi-mcp-adapter@2.32.1"]
        );
    }

    /// 第三轮评审修复：parse_npm_source 四形态（非 scoped 带版本/裸名/
    /// scoped 带版本/scoped 无版本）——旧 rsplit 对末形态解出
    /// ("", "scope/pkg")。super:: 限定——本 tests 模块无 use super::*。
    #[test]
    fn parse_npm_source_four_shapes() {
        assert_eq!(
            super::parse_npm_source("npm:pi-subagents@0.72.0"),
            ("pi-subagents".to_string(), "0.72.0".to_string())
        );
        assert_eq!(
            super::parse_npm_source("npm:pi-subagents"),
            ("pi-subagents".to_string(), String::new())
        );
        assert_eq!(
            super::parse_npm_source("npm:@juicesharp/rpiv-todo@2.15.0"),
            ("@juicesharp/rpiv-todo".to_string(), "2.15.0".to_string())
        );
        assert_eq!(
            super::parse_npm_source("npm:@juicesharp/rpiv-todo"),
            ("@juicesharp/rpiv-todo".to_string(), String::new())
        );
    }

    /// v0.9.5 需求5：4 扩展钉定源与目录名对齐（安装探测落点 = node_modules/
    /// <目录名>；scoped 包目录名含 @scope/ 层级），且源均为 npm: 带精确版本。
    /// v0.9.8 D4-8：常量改数据驱动（builtin.json），断言语义不变。
    #[test]
    fn pi_extension_packages_pinned_and_scoped_dirs() {
        let packages = builtin_extensions();
        assert_eq!(packages.len(), 5);
        for (source, dir, _display) in packages {
            assert!(source.starts_with("npm:"), "{source} 非 npm 源");
            let name = source
                .strip_prefix("npm:")
                .and_then(|s| s.rsplit_once('@'))
                .map(|(n, ver)| {
                    assert!(
                        ver.chars().all(|c| c.is_ascii_digit() || c == '.'),
                        "{source} 版本非精确钉定"
                    );
                    n
                })
                .unwrap();
            assert_eq!(name, dir, "{source} 与目录名 {dir} 不一致");
        }
        // 包名 → 钉定源反查（packages 同步真源）：4 扩展 + web 共 5 项
        //（pi-mcp-adapter 已随 pi 1.1.0 原生 MCP 退役——需求11，不再安装）。
        for name in [
            "pi-subagents",
            "@juicesharp/rpiv-ask-user-question",
            "@juicesharp/rpiv-todo",
            "pi-lens",
            "pi-web-access",
        ] {
            assert!(
                super::JishuSelfAgent::pinned_source_for_package(name).is_some(),
                "{name} 无钉定源"
            );
        }
        assert!(
            super::JishuSelfAgent::pinned_source_for_package("pi-mcp-adapter").is_none(),
            "退役包不得再有钉定源"
        );
    }
}

impl TransportAdapter for JishuSelfAgent {
    fn transport_surface(&self) -> crate::agent::TransportSurface {
        crate::agent::TransportSurface::PiRpc
    }

    fn build_chat_command(&self, req: ChatRequest) -> tokio::process::Command {
        let spec = self
            .build_acp_command(&req)
            .unwrap_or_else(|_| crate::agent::AcpCommandSpec {
                program: "pi".to_string(),
                args: vec!["--mode".to_string(), "rpc".to_string()],
                envs: Vec::new(),
            });
        let mut cmd = crate::os_adapter::shell::shell_command(&spec.program, spec.args);
        cmd.current_dir(&req.project_path);
        for (key, value) in spec.envs {
            cmd.env(key, value);
        }
        crate::process_command::tokio_no_window(&mut cmd);
        cmd
    }

    fn build_acp_command(&self, req: &ChatRequest) -> Result<crate::agent::AcpCommandSpec, String> {
        let runtime = pi_runtime::resolve_pi_runtime()?;
        let mut args = runtime.base_args;
        // Use Pi's native --mode rpc (JSON-line protocol) instead of the
        // non-existent --acp flag. The Pi RPC runtime module handles the
        // protocol translation (prompt/abort commands, AgentEvent normalization).
        args.push("--mode".to_string());
        args.push("rpc".to_string());
        // P-1（需求2）：只读工具模式 —— Hub 全局设置为 readonly 时追加 Pi 的
        // --tools 白名单（内置全集 read/bash/edit/write/grep/find/ls 去掉
        // bash/edit/write）。工具名与语义是 Pi 私有知识，属于 adapter 职责；
        // 对此后新 spawn 的进程生效（Pi 每条消息一个进程）。
        let pi_extension_tools = crate::agent::plugin::enabled_pi_extension_tools();
        if let Some("readonly") = crate::hub::load_agent_tool_mode("jishu-self").as_deref() {
            // 只读模式保留交互与任务提交类扩展工具（问答纯交互；
            // lock/commit 为工作流操作，任务流须可用）。
            let mut tools: Vec<String> = ["read", "grep", "find", "ls"]
                .iter()
                .map(|s| s.to_string())
                .collect();
            tools.extend_from_slice(&pi_extension_tools);
            args.push("--tools".to_string());
            args.push(tools.join(","));
            // v0.9.5 需求11：pi 1.0.4 起 --tools 白名单不再滤出 MCP 工具
            //（04b97ef00）——只读档需显式 --no-mcp 保持「无外部工具」原语义
            //（MCP 工具良菱不齐，变更类工具不应进只读会话）。
            args.push("--no-mcp".to_string());
        }
        // 需求17（2026-11-21 用户裁决）：工具白名单根因修复——spawn 时不再
        // 传 --tools。此前每次 spawn 都传硬白名单，导致 hub 不知道的工具来
        // 源（npm 扩展等）被屏蔽（历史四次跌倒：内置扩展→runner→agent-tools
        // →npm 扩展，每次都要手工补白名单）。
        //
        // 对齐 pi 原生管理方式：
        // - 核心工具：pi settings.json `defaultTools`（启动时由
        //   pi_tools_config::ensure_default_tools_config 幂等写入全量清单）
        // - 扩展工具：pi settings.json `packages`（装了就加载，停了就不加载）
        // - MCP 工具：pi 原生 direct 暴露机制（不传 --tools 时自然可用）
        // - agent-tools：pi 原生扩展加载（物化到 extensions/ 后 pi 自动注册）
        //
        // 只读模式仍传限制性 --tools（上方分支处理）。
        //
        // 注意：ensure_default_tools_config 在 lib.rs setup 中调用（迁移之后），
        // 首次升级时 defaultTools 即已写入，后续 spawn 不依赖命令行白名单。
        // Resume an existing Pi session when a real (non-transient) session id
        // is provided. Without this, Pi creates a fresh session on every process
        // spawn, losing all conversation history (the root cause of "agent
        // doesn't remember previous turns after restart"). Pi's --session-id
        // accepts an exact project session id and resumes it if it exists,
        // creating it if missing.
        if let Some(session_id) = req.session_id.as_ref().filter(|id| !id.is_empty()) {
            args.push("--session-id".to_string());
            args.push(session_id.clone());
        }
        args.push("--append-system-prompt".to_string());
        args.push(JISHU_AGENT_IDENTITY_PROMPT.to_string());
        // v0.9.5 需求2：节点/委派模型覆盖（ChatRequest.model_override）——
        // 优先于全局 active；签名机制天然区分（不同模型=独立进程）。
        args.extend(pi_model::build_pi_model_args_with_override(
            req.model_override.as_ref(),
        )?);

        let mut envs = Vec::new();
        envs.push(("PI_SKIP_VERSION_CHECK".to_string(), "1".to_string()));
        // v0.9.1 需求3 #6：关闭 pi 启动期网络操作（版本检查/包管理器/模型目录
        // 网络刷新——model-runtime 的 modelNetworkEnabled）。hub 自管模型库与
        // 版本分发，这些网络操作纯浪费且离线时拖慢 spawn；该 flag 不门控对话
        // 期的 provider HTTP 请求。
        envs.push(("PI_OFFLINE".to_string(), "1".to_string()));

        // Always resolve the CLI explicitly for spawned Pi processes. Debug
        // resolves to target/debug/jishu-cli(.exe); installed builds resolve
        // to the packaged production CLI next to the app/resources.
        match resolve_jishu_cli_binary() {
            Ok(cli) => {
                log::info!("[task-plan-runtime] cli={}", cli.display());
                envs.push((
                    "JISHU_CLI_BIN".to_string(),
                    cli.to_string_lossy().to_string(),
                ));
            }
            Err(err) => {
                log::warn!("[task-plan-runtime] failed to resolve jishu-cli: {err}");
            }
        }
        // v0.9.1 需求12 补充：会话环境变量（配置页高级设置）——settings.json
        // 的 hubSpawnEnv（hub 专属键；pi 读写走全量 spread，未知键无损保留）
        // 逐项附加注入 pi 会话进程。置于内置默认之后，用户可覆盖（如
        // PI_OFFLINE="" 关闭离线刷新、HTTP(S)_PROXY 走代理）。
        envs.extend(spawn_env_overrides(&config::load_jishu_config()));
        // v0.9.4 需求9 P3：MCP 指纹进 spawn 签名（仅总开关）。pi 不重读
        // mcp.json（pi-mcp-adapter 无 config watch），会话中途首次启用/关闭
        // 解析器时，运行中进程的册子上连解析器入口工具都没有——唯一必须
        // 换进程的场景。指纹进入 acp_turn_signature → 下一次空闲发送时
        // 漂移回收重拉（resume 同一会话，历史不丢）。插件明细**不进**指纹：
        // 热插拔由 hub_mcp_list/hub_mcp_call 动态发现承担，换进程反而打断
        //（02 §二 P3）。
        envs.push((
            "JISHU_MCP_REV".to_string(),
            format!(
                "resolver:{}",
                if crate::agent::plugin::is_mcp_resolver_enabled() {
                    "on"
                } else {
                    "off"
                }
            ),
        ));

        Ok(crate::agent::AcpCommandSpec {
            program: runtime.program.to_string_lossy().to_string(),
            args,
            envs,
        })
    }

    fn resolved_session_prompt_injection(&self) -> Option<ResolvedSessionPromptInjection> {
        // session_id 改由 session-context 扩展注入 system prompt（before_agent_start），
        // 不再往 user message 拼提示词（避免污染会话列表名/内容/搜索）。返回 None 下线注入。
        None
    }

    fn pipe_chat_stdin(&self) -> bool {
        false
    }

    fn consumes_stdin_message(&self) -> bool {
        false
    }
}

impl EventNormalizer for JishuSelfAgent {
    fn stream_event_normalizer(&self) -> crate::agent::StreamEventNormalizer {
        crate::agent::default_stream_event_normalizer
    }

    fn parse_stream_event(&self, event: &serde_json::Value) -> String {
        if let Some(kind) = event.get("kind").and_then(|v| v.as_str()) {
            return kind.to_string();
        }
        "unknown".to_string()
    }
}

impl TerminalAdapter for JishuSelfAgent {
    fn open_in_terminal(
        &self,
        project_path: &str,
        resume_session_id: Option<&str>,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        let command = resume_session_id
            .map(|sid| self.build_resume_command(sid))
            .unwrap_or_else(|| self.build_launch_command());
        let window_id = resume_session_id
            .map(|sid| crate::agent::command_config::terminal_window_id("jishu-self", sid));
        crate::command::open_agent_terminal(project_path, &command, window_id.as_deref())
    }

    fn open_in_terminal_with_command(
        &self,
        project_path: &str,
        command: &str,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        crate::command::open_in_terminal_with_command(project_path, command)
    }

    fn build_resume_command(&self, session_id: &str) -> String {
        format!("jishu-cli chat resume {session_id}")
    }

    fn build_launch_command(&self) -> String {
        "jishu-cli chat start --agent jishu-self --project .".to_string()
    }

    fn build_init_command(&self) -> String {
        let prompt = "Please initialize this project and tell me when it's done.";
        format!("jishu-cli run \"{prompt}\"")
    }

    fn built_in_commands(&self) -> Vec<crate::agent::command_config::AgentCommandPreset> {
        use crate::agent::command_config::AgentCommandPreset;
        vec![
            AgentCommandPreset {
                name: "jishu-cli --version".into(),
                command: "jishu-cli --version".into(),
            },
            AgentCommandPreset {
                name: "jishu-cli agents list".into(),
                command: "jishu-cli agents list".into(),
            },
            AgentCommandPreset {
                name: "jishu-cli model list".into(),
                command: "jishu-cli model list".into(),
            },
            AgentCommandPreset {
                name: "jishu-cli doctor".into(),
                command: "jishu-cli doctor".into(),
            },
        ]
    }
}

#[cfg(test)]
mod agent_tool_whitelist_tests {
    use super::{extract_conflict_pairs, merge_agent_tool_names, pkg_dir_from_path};

    /// 需求15 方案 A v2：冲突对提取——双向（self/opponent）+路径→包名。
    #[test]
    fn extract_conflict_pairs_from_diagnostics() {
        let stderr = concat!(
            "Warning: Extension package \"x\": Host-provided packages must be in peerDependencies.\n",
            "Failed to load extension \"C:\\u\\agent\\npm\\node_modules\\@juicesharp\\rpiv-web-tools\\index.ts\": Tool \"web_search\" conflicts with C:\\u\\agent\\npm\\node_modules\\pi-web-access\\dist\\index.js\n",
            "Failed to load extension \"C:\\u\\agent\\npm\\node_modules\\@juicesharp\\rpiv-web-tools\\index.ts\": Tool \"fetch_content\" conflicts with C:\\u\\agent\\npm\\node_modules\\pi-web-access\\dist\\index.js\n",
            "Failed to load extension \"C:\\u\\agent\\npm\\node_modules\\@juicesharp\\rpiv-web-tools\\index.ts\": Tool \"web_search\" conflicts with C:\\u\\agent\\npm\\node_modules\\pi-web-access\\dist\\index.js\n",
        );
        // rpiv（失败方）与 pi-web-access（对手）双向；多工具全量；去重。
        let conflicts = extract_conflict_pairs(stderr);
        assert_eq!(conflicts.len(), 2, "{conflicts:?}");
        assert_eq!(conflicts[0].tool, "web_search");
        assert_eq!(conflicts[0].self_pkg, "@juicesharp/rpiv-web-tools");
        assert_eq!(conflicts[0].opponent_pkg, "pi-web-access");
        assert_eq!(conflicts[1].tool, "fetch_content");
        // 反向行（先注册方被报冲突）：self/opponent 仍各自正确。
        let reversed = concat!(
            "Error: Failed to load extension \"C:\\u\\agent\\npm\\node_modules\\pi-web-access\\dist\\index.js\": ",
            "Tool \"web_search\" conflicts with ",
            "C:\\u\\agent\\npm\\node_modules\\@juicesharp\\rpiv-web-tools\\index.ts\n"
        );
        let r = &extract_conflict_pairs(reversed)[0];
        assert_eq!(r.self_pkg, "pi-web-access");
        assert_eq!(r.opponent_pkg, "@juicesharp/rpiv-web-tools");
        // scoped 拼接 + 无冲突 → 空。
        assert_eq!(
            pkg_dir_from_path("C:\\x\\node_modules\\@scope\\pkg\\dist\\i.js").as_deref(),
            Some("@scope/pkg")
        );
        assert!(extract_conflict_pairs("all good").is_empty());
    }

    /// v0.9.8 需求10-③ P1 回归锚点：[[agent-tool]] 物化名并入 spawn 白名单
    /// （pi --tools 硬白名单不进名单则 agent 不可见——修复前该通道全断）。
    /// 去重合并 + 空物化不添噪声。
    #[test]
    fn merge_agent_tool_names_dedupes_and_appends() {
        let merged = merge_agent_tool_names(vec!["read".to_string(), "bash".to_string()]);
        // 当前物化清单为空（测试环境无 [[agent-tool]] 件）——空清单原样返回
        assert!(merged.iter().all(|n| n == "read" || n == "bash"));
        // 物化清单非空时并入（读真实 agent-tools.json——测试隔离下由
        // JISHU_HUB_HOME 指向临时目录；此处验证合并行为本身：注入临时清单）
        let dir = std::env::temp_dir().join("jishu-test-agent-tools-merge");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("agent-tools.json"),
            r#"[{"plugin_id":"p1","name":"probe_a","description":"d"},{"plugin_id":"p2","name":"read","description":"d"}]"#,
        )
        .unwrap();
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        std::env::set_var("JISHU_HUB_HOME", &dir);
        let merged = merge_agent_tool_names(vec!["read".to_string()]);
        std::env::remove_var("JISHU_HUB_HOME");
        let _ = std::fs::remove_dir_all(&dir);
        // probe_a 新并入；read 已在基集不重复
        assert!(
            merged.iter().any(|n| n == "probe_a"),
            "agent-tool 未进白名单"
        );
        assert_eq!(
            merged.iter().filter(|n| *n == "read").count(),
            1,
            "重复并入"
        );
    }
}
