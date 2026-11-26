//! Agent 预连接池（v0.9.7 需求12）。
//!
//! 用户诉求：jishu agent 对话第一次连接很慢（进程冷启动：Node 加载、扩展
//! 装载、MCP 聚合连接都发生在进程启动阶段）。预连接 = 提前按「当前焦点
//! 标签项目」spawn 好 jishu agent RPC 进程存池，新会话首连直接接管现成
//! 进程，冷启动时间归零。
//!
//! 形态与边界（用户定案 2026-11-11）：
//! - **内置插件形态**：`session.agent-preconnect` 登记进插件中心，开关即
//!   池总闸，配置面 `maxPool`（默认 3，1..=8）即池深——「用掉的预连接数
//!   不算」= 空闲条目恒补齐到 maxPool；
//! - **跟随当前标签项目**：启动时给起始标签预连、切标签给新标签预连
//!   （旧项目条目全杀——池只服务单一焦点项目）；
//! - **仅接管新会话首连**：resume/fork 轮的 `--session-id` 定死于进程启动
//!   参数，池进程无法事后补挂，天然不接管（签名比对也兜底）；对象由能力位
//!   判定——声明 PRECONNECTABLE 的 agent + PiRpc（评审 P2-⑤ 用户裁决：
//!   能力化替代 agent id 分支）；
//! - **签名一致性**：池条目按 `acp_command_signature`（与回合签名同一把
//!   尺）预存签名，接管时与真实回合的 command 比对——模型/工具面/env 任何
//!   漂移即不匹配，回落正常 spawn 路径（安全方向：宁可慢，不可错进程）。
//!
//! 进程安全：pi RPC 模式进入命令循环后不主动写 stdout（`takeOverStdout`
//! 后仅响应命令才输出，见 third_party/pi rpc-mode.ts），池中进程无管道
//! 堵塞风险；启动诊断走 stderr（64KB 管道余量充足）。
//!
//! 生命周期：池条目无看护任务——死进程在 take/ensure_focus 时顺手清
//! (`try_wait`)；hub 退出统一 `shutdown_all`（RunEvent::Exit）。

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use crate::agent::AgentRegistry;
use crate::agent_runtime::{self, PreparedAcpTurn};

/// 插件中心条目 id（`builtin_session_plugin_specs` 按此对齐）。
pub const PLUGIN_ID: &str = "session.agent-preconnect";
const DEFAULT_MAX_POOL: usize = 3;
const MAX_POOL_LIMIT: usize = 8;

/// 评审 P2-⑤ 用户裁决：能力化替代 agent id 分支——预连对象不再硬编码
/// "jishu-self"，改为经 registry 查谁声明了 PRECONNECTABLE 能力位
/// （唯一声明者即为池对象；无声明者则池空转）。
fn preconnectable_agent_id(registry: &AgentRegistry) -> Option<String> {
    registry
        .agents_info()
        .into_iter()
        .find(|(_, agent)| {
            agent
                .capabilities()
                .contains(crate::agent::AgentCapabilities::PRECONNECTABLE)
        })
        .map(|(id, _)| id)
}

// ── 配置 ──

pub(crate) struct Settings {
    pub(crate) enabled: bool,
    pub(crate) max_pool: usize,
}

/// 插件开关 + maxPool 快照（plugins.json disabled 集 × plugins-config.json
/// 用户值；非法/缺失回默认——插件配置语义：未显式改过的键走代码默认）。
pub(crate) fn settings() -> Settings {
    let disabled = crate::agent::plugin::load_plugin_config().disabled;
    let enabled = !disabled.iter().any(|id| id == PLUGIN_ID);
    let max_pool = crate::agent::plugin_options::load_all()
        .get(PLUGIN_ID)
        .and_then(|values| values.get("maxPool"))
        .and_then(|v| v.as_u64())
        .map(|v| v.clamp(1, MAX_POOL_LIMIT as u64) as usize)
        .unwrap_or(DEFAULT_MAX_POOL);
    Settings { enabled, max_pool }
}

// ── 池 ──

struct Entry {
    project_path: String,
    signature: String,
    child: tokio::process::Child,
    #[allow(dead_code)] // 取证字段：日志/后续 TTL 策略的锚点
    created_at: Instant,
}

struct Pool {
    /// 当前焦点项目（最新一次 ensure_focus 设定；None = 池关闭）。
    focus: Option<String>,
    entries: Vec<Entry>,
}

static POOL: OnceLock<Mutex<Pool>> = OnceLock::new();

fn pool() -> &'static Mutex<Pool> {
    POOL.get_or_init(|| {
        Mutex::new(Pool {
            focus: None,
            entries: Vec::new(),
        })
    })
}

/// 条目死活：`try_wait` Ok(Some) = 已退出；Err（句柄异常）按死处理
/// （宁可误杀补新，不留死条目占池位）。
fn entry_dead(entry: &mut Entry) -> bool {
    matches!(entry.child.try_wait(), Ok(Some(_)) | Err(_))
}

/// 锁内清扫死条目，返回清扫后的存活数。
fn sweep_dead(pool: &mut Pool) -> usize {
    pool.entries.retain_mut(|e| !entry_dead(e));
    pool.entries.len()
}

/// 杀掉全部条目并清空池（同步发信号，不等进程咽气——`start_kill` 非阻塞）。
fn kill_all(pool: &mut Pool) {
    for mut entry in pool.entries.drain(..) {
        if let Err(e) = entry.child.start_kill() {
            log::warn!("[preconnect] kill pid {:?} failed: {e}", entry.child.id());
        }
    }
}

/// hub 退出/插件禁用时的总清（RunEvent::Exit 与 ensure_focus 禁用分支调用）。
pub fn shutdown_all(reason: &str) {
    let mut guard = pool().lock().unwrap_or_else(|e| e.into_inner());
    let count = guard.entries.len();
    guard.focus = None;
    kill_all(&mut guard);
    if count > 0 {
        log::info!("[preconnect] shutdown ({reason}): killed {count} process(es)");
    }
}

// ── spawn ──

/// 按「新会话首连」形态构建预连对象的启动 spec（session_id=None → 无
/// --session-id，与真实首连逐参数一致；tools 白名单/模型 args/envs 全跟
/// 随当前配置）+ 签名。registry 缺 agent/构建失败返回 None（调用方放弃补池）。
fn build_spec(
    registry: &AgentRegistry,
    agent_id: &str,
    project_path: &str,
) -> Option<(crate::agent::AcpCommandSpec, String)> {
    let request = crate::agent_runtime::AgentTurnRequest {
        agent_id: agent_id.to_string(),
        project_path: project_path.to_string(),
        session_id: None,
        message: String::new(),
        timeout_secs: 0,
        model_override: None,
        pending_entry: None,
        user_text: None,
    };
    let prepared = agent_runtime::prepare_gui_turn(registry, request).ok()?;
    let agent_runtime::PreparedGuiTurn::Acp(acp) = &prepared else {
        return None;
    };
    let signature = agent_runtime::acp_command_signature(&acp.command)?;
    Some((acp.command.clone(), signature))
}

/// spawn 后锁内插池（评审 P1-2 复查点）。spawn 与插池之间事件可能交错：
/// 并发 fill 任务都已 spawn、`ensure_focus` 恰在此时收缩/禁用插件、用户调小
/// maxPool——插入时点的池深与开关必须按锁内最新状态复查，超限/关闸即杀掉
/// 刚 spawn 的进程并停手，杜绝池被异步任务撑爆。返回是否成功入池。
fn insert_spawned(
    settings: &Settings,
    project_path: &str,
    signature: String,
    mut child: tokio::process::Child,
) -> bool {
    let mut guard = pool().lock().unwrap_or_else(|e| e.into_inner());
    if guard.focus.as_deref() != Some(project_path) {
        // 焦点已变：杀掉这个刚 spawn 的，停止补旧项目。
        let _ = child.start_kill();
        return false;
    }
    if !settings.enabled || guard.entries.len() >= settings.max_pool {
        // 容量/开关复查：以插池瞬间快照为准，杀超额进程（评审 P1-2）。
        let _ = child.start_kill();
        log::info!(
            "[preconnect] dropped excess spawn for {project_path} (pool={} max={} enabled={})",
            guard.entries.len(),
            settings.max_pool,
            settings.enabled
        );
        return false;
    }
    guard.entries.push(Entry {
        project_path: project_path.to_string(),
        signature,
        child,
        created_at: Instant::now(),
    });
    true
}

/// 后台补池任务：spawn 到目标条数。spawn 后经 `insert_spawned` 重新锁池插入
/// ——焦点切走或容量超限即杀掉刚 spawn 的进程并停手（不再补旧项目）。
fn fill_async(
    registry: std::sync::Arc<AgentRegistry>,
    agent_id: String,
    project_path: String,
    want: usize,
) {
    tauri::async_runtime::spawn(async move {
        for _ in 0..want {
            // 每次 spawn 前用最新配置构建（长池龄期间用户可能改模型/工具面）。
            let Some((spec, signature)) = build_spec(&registry, &agent_id, &project_path) else {
                log::warn!("[preconnect] build spec failed for {project_path}, skip refill");
                return;
            };
            let child =
                match agent_runtime::build_tokio_command_from_spec(&spec, &project_path).spawn() {
                    Ok(child) => child,
                    Err(e) => {
                        // CLI 缺失/系统资源不足等硬失败：本轮流补池到此为止
                        //（下次 focus 变化/取用后重试），不无限重试。
                        log::warn!("[preconnect] spawn failed for {project_path}: {e}");
                        return;
                    }
                };
            log::info!(
                "[preconnect] warmed pid {:?} for {project_path}",
                child.id()
            );
            if !insert_spawned(&settings(), &project_path, signature, child) {
                return;
            }
        }
    });
}

// ── 入口 ──

/// 声明焦点项目并维持池深（幂等）：
/// - 插件禁用 → 全清关池；
/// - 焦点未变 → 清死条目 + 补缺口（取用后的「用掉即补」走同一入口）；
/// - 焦点变化 → 旧条目全杀，换焦点补齐。
///
/// 前端启动/切标签时经 `plugin_preconnect_focus` 命令触发；快速连续切换
/// 不会堆积——fill 插回时校验焦点，漂移即杀。
pub fn ensure_focus(registry: &std::sync::Arc<AgentRegistry>, project_path: &str) {
    let s = settings();
    if !s.enabled {
        // 禁用时仍记录焦点记忆（用户意图），只杀不建——重新启用后下一次
        // 联动/声明即刻恢复。
        let mut guard = pool().lock().unwrap_or_else(|e| e.into_inner());
        let killed = guard.entries.len();
        guard.focus = Some(project_path.to_string());
        kill_all(&mut guard);
        if killed > 0 {
            log::info!("[preconnect] plugin disabled, killed {killed} process(es) (focus kept)");
        }
        return;
    }
    // 评审 P2-⑤：经 registry 能力位解析预连对象，无人声明则只清不建。
    let Some(agent_id) = preconnectable_agent_id(registry) else {
        let mut guard = pool().lock().unwrap_or_else(|e| e.into_inner());
        let killed = guard.entries.len();
        guard.focus = Some(project_path.to_string());
        kill_all(&mut guard);
        if killed > 0 {
            log::info!(
                "[preconnect] no PRECONNECTABLE agent, killed {killed} process(es) (focus kept)"
            );
        }
        return;
    };
    let want = {
        let mut guard = pool().lock().unwrap_or_else(|e| e.into_inner());
        if guard.focus.as_deref() != Some(project_path) {
            let killed = guard.entries.len();
            guard.focus = Some(project_path.to_string());
            kill_all(&mut guard);
            if killed > 0 {
                log::info!(
                    "[preconnect] focus switched to {project_path}: killed {killed} old entrie(s)"
                );
            }
        }
        let live = sweep_dead(&mut guard);
        // 池深收缩（maxPool 调小）：杀掉超额条目。remove(0) 杀最老的队首
        // 进程、保留队尾新进程（评审 P2-⑥：原 pop 与注释语义相反）。
        if live > s.max_pool {
            let excess = live - s.max_pool;
            for _ in 0..excess {
                if !guard.entries.is_empty() {
                    let pid = guard.entries[0].child.id();
                    let _ = guard.entries[0].child.start_kill();
                    guard.entries.remove(0);
                    log::info!("[preconnect] pool shrunk: killed pid {pid:?}");
                }
            }
            log::info!("[preconnect] pool shrunk: killed {excess} excess entrie(s)");
        }
        s.max_pool.saturating_sub(guard.entries.len())
    };
    if want > 0 {
        fill_async(registry.clone(), agent_id, project_path.to_string(), want);
    }
}

/// 插件开关/配置面变更联动（`plugin_set_enabled` / `plugin_config_set`
/// 尾部调用）：禁用即杀光池进程（**保留焦点记忆**——重新启用即刻按记忆
/// 重建；`shutdown_all` 是 app 退出专用、会清记忆）；启用/调深/调浅按池内
/// 记忆的焦点项目重建（记忆为空——如启动后从未声明过焦点——则静默等
/// 前端下一次声明）。
pub fn on_settings_changed(registry: &std::sync::Arc<AgentRegistry>) {
    if !settings().enabled {
        let mut guard = pool().lock().unwrap_or_else(|e| e.into_inner());
        let killed = guard.entries.len();
        kill_all(&mut guard);
        if killed > 0 {
            log::info!("[preconnect] plugin disabled: killed {killed} process(es)");
        }
        return;
    }
    let focus = {
        let guard = pool().lock().unwrap_or_else(|e| e.into_inner());
        guard.focus.clone()
    };
    if let Some(project_path) = focus {
        ensure_focus(registry, &project_path);
    }
}

/// 新会话首连接管判定 + 取用（`start_gui_acp_turn` 调用）：
/// 匹配（agent 声明 PRECONNECTABLE × PiRpc × 无 native_session_id × 同项目
/// × 同签名 × 进程活着）弹出条目返回 child；任何不匹配返回 None（调用方
/// 回落正常 spawn）。同项目但签名漂移的死配置条目顺手杀——配置变了进程即废。
pub fn take_for_turn(
    registry: &AgentRegistry,
    turn: &PreparedAcpTurn,
) -> Option<tokio::process::Child> {
    if turn.transport != crate::agent::TransportSurface::PiRpc
        || turn.native_session_id.is_some()
        // 评审 P2-⑤ 用户裁决：能力化替代 agent id 分支——目标 agent 未声明
        // PRECONNECTABLE 即不接管（含 registry 缺 agent 的情况）。
        || !preconnectable_agent_id(registry).is_some_and(|id| id == turn.agent_id)
    {
        return None;
    }
    let signature = agent_runtime::acp_command_signature(&turn.command)?;
    let mut guard = pool().lock().unwrap_or_else(|e| e.into_inner());
    // 漂移条目（同项目、签名不同）与死条目一并清掉。
    let mut idx = None;
    let mut i = 0;
    while i < guard.entries.len() {
        let entry = &mut guard.entries[i];
        let same_project = entry.project_path == turn.project_path;
        if same_project && entry.signature != signature {
            let dead = entry_dead(entry);
            let _ = entry.child.start_kill();
            guard.entries.remove(i);
            log::info!(
                "[preconnect] dropped drifted/dead entry ({dead}) for {}",
                turn.project_path
            );
            continue;
        }
        if idx.is_none() && same_project && entry.signature == signature && !entry_dead(entry) {
            idx = Some(i);
        }
        i += 1;
    }
    let idx = idx?;
    let entry = guard.entries.remove(idx);
    log::info!(
        "[preconnect] takeover pid {:?} for new session in {}",
        entry.child.id(),
        entry.project_path
    );
    Some(entry.child)
}

// ── 测试 ──

#[cfg(test)]
mod tests {
    use super::*;

    /// 配置解析：未配置回默认 3；用户值 clamp 1..=8；禁用集关闸。
    /// （池的进程级行为——spawn/接管/焦点切换——依赖真实 jishu-self CLI，
    /// 不在单测覆盖，dev 实测锚点见 docs/v0.9.7/需求12。）
    #[test]
    fn settings_read_user_max_pool() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", home.path());

        let s = settings();
        assert!(s.enabled, "no config => enabled by default");
        assert_eq!(s.max_pool, DEFAULT_MAX_POOL);

        let mut values = std::collections::HashMap::new();
        values.insert("maxPool".to_string(), serde_json::json!(5));
        crate::agent::plugin_options::set_values(PLUGIN_ID, values).unwrap();
        assert_eq!(settings().max_pool, 5);

        // 超上限 clamp（下限由前端 min 校验 + as_u64 语义天然覆盖 0 → default? 0 不合法回 default）。
        let mut values = std::collections::HashMap::new();
        values.insert("maxPool".to_string(), serde_json::json!(99));
        crate::agent::plugin_options::set_values(PLUGIN_ID, values).unwrap();
        assert_eq!(settings().max_pool, MAX_POOL_LIMIT);

        // 非法值（字符串/缺键）回默认。
        let mut values = std::collections::HashMap::new();
        values.insert("maxPool".to_string(), serde_json::json!("three"));
        crate::agent::plugin_options::set_values(PLUGIN_ID, values).unwrap();
        assert_eq!(settings().max_pool, DEFAULT_MAX_POOL);

        // 禁用闸：disabled 集含插件 id → enabled=false。
        let mut config = crate::agent::plugin::load_plugin_config();
        config.disabled.push(PLUGIN_ID.to_string());
        crate::agent::plugin::save_plugin_config(&config).unwrap();
        assert!(!settings().enabled);
    }

    /// 真实子进程占位（池条目需要 Child 句柄；kill_on_drop 兜底清理）。
    fn spawn_test_child() -> tokio::process::Child {
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut c = tokio::process::Command::new("cmd");
            c.args(["/C", "ping -n 6 127.0.0.1 >nul"]);
            c
        };
        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut c = tokio::process::Command::new("sh");
            c.args(["-c", "sleep 5"]);
            c
        };
        command
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true);
        command.spawn().unwrap()
    }

    fn clear_pool(focus: Option<&str>) {
        let mut guard = pool().lock().unwrap_or_else(|e| e.into_inner());
        guard.focus = focus.map(str::to_string);
        kill_all(&mut guard);
    }

    /// 评审 P1-2：插池复查——池满或插件禁用即杀刚 spawn 的进程、不入池
    /// （spawn 与插池之间事件交错的兜底）。
    #[test]
    fn insert_spawned_rechecks_capacity_and_enabled() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        clear_pool(Some("D:/p"));

        let enabled = Settings {
            enabled: true,
            max_pool: 1,
        };
        let child_a = spawn_test_child();
        assert!(insert_spawned(&enabled, "D:/p", "sig-a".into(), child_a));
        assert_eq!(pool().lock().unwrap().entries.len(), 1);

        // 池满：第二条必须被杀掉拒插（评审 P1-2 容量复查）。
        let child_b = spawn_test_child();
        assert!(!insert_spawned(&enabled, "D:/p", "sig-b".into(), child_b));
        assert_eq!(pool().lock().unwrap().entries.len(), 1);

        // 焦点漂移：同样拒插。
        let child_c = spawn_test_child();
        assert!(!insert_spawned(
            &enabled,
            "D:/other",
            "sig-c".into(),
            child_c
        ));

        // 禁用闸：关闸后拒插。
        let disabled = Settings {
            enabled: false,
            max_pool: 8,
        };
        let child_d = spawn_test_child();
        assert!(!insert_spawned(&disabled, "D:/p", "sig-d".into(), child_d));
        assert_eq!(pool().lock().unwrap().entries.len(), 1);

        clear_pool(None);
    }

    /// 构造 PiRpc 形态的回合（真实首连形态：无 native_session_id）。
    fn pi_rpc_turn(agent_id: &str) -> PreparedAcpTurn {
        PreparedAcpTurn {
            agent_id: agent_id.into(),
            project_path: "D:/p".into(),
            gui_session_id: None,
            native_session_id: None,
            message: String::new(),
            command: crate::agent::AcpCommandSpec {
                program: "node".into(),
                args: vec!["--mode".into(), "rpc".into()],
                envs: vec![],
            },
            transport: crate::agent::TransportSurface::PiRpc,
            resolved_session_prompt_injection: None,
            pending_entry: None,
            user_text: None,
        }
    }

    /// 评审 P2-⑤：接管判定按 PRECONNECTABLE 能力位——声明者可接管，
    /// 未声明者拒（能力化替代 agent id 硬编码分支）。
    #[test]
    fn take_for_turn_gates_on_preconnectable_capability() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let registry = std::sync::Arc::new(AgentRegistry::new());

        // 能力声明基线：jishu-self 声明、codex 未声明。
        assert!(registry
            .get("jishu-self")
            .unwrap()
            .capabilities()
            .contains(crate::agent::AgentCapabilities::PRECONNECTABLE));
        assert!(!registry
            .get("codex")
            .unwrap()
            .capabilities()
            .contains(crate::agent::AgentCapabilities::PRECONNECTABLE));

        // 无能力 → 拒（同 PiRpc 形态，仅 agent 未声明能力位）。
        assert!(take_for_turn(&registry, &pi_rpc_turn("codex")).is_none());

        // 有能力 → 池中有同项目、同签名、活条目即可接管。
        clear_pool(Some("D:/p"));
        let turn = pi_rpc_turn("jishu-self");
        let signature = agent_runtime::acp_command_signature(&turn.command).unwrap();
        let child = spawn_test_child();
        let enabled = Settings {
            enabled: true,
            max_pool: 3,
        };
        assert!(insert_spawned(&enabled, "D:/p", signature, child));
        assert!(
            take_for_turn(&registry, &turn).is_some(),
            "声明 PRECONNECTABLE 且签名匹配应接管"
        );
        assert_eq!(pool().lock().unwrap().entries.len(), 0, "接管即弹出");
        clear_pool(None);
    }

    /// 评审 P2-⑥：池收缩杀最老（队首 remove(0)）、保留队尾新进程——
    /// 插入 a、b 两条后收缩到 maxPool=1，幸存者必须是后插的 sig-b。
    #[test]
    fn pool_shrink_kills_oldest_keeps_newest() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", home.path());
        // maxPool 配置为 1 → 两条目必触发收缩。
        let mut values = std::collections::HashMap::new();
        values.insert("maxPool".to_string(), serde_json::json!(1));
        crate::agent::plugin_options::set_values(PLUGIN_ID, values).unwrap();

        let registry = std::sync::Arc::new(AgentRegistry::new());
        clear_pool(Some("D:/p"));
        let enabled = Settings {
            enabled: true,
            max_pool: 2,
        };
        let child_a = spawn_test_child();
        let child_b = spawn_test_child();
        assert!(insert_spawned(&enabled, "D:/p", "sig-a".into(), child_a));
        assert!(insert_spawned(&enabled, "D:/p", "sig-b".into(), child_b));
        assert_eq!(pool().lock().unwrap().entries.len(), 2);

        // 焦点未变 → ensure_focus 走收缩分支：杀队首最老（sig-a）。
        ensure_focus(&registry, "D:/p");

        let guard = pool().lock().unwrap_or_else(|e| e.into_inner());
        let signatures: Vec<&str> = guard.entries.iter().map(|e| e.signature.as_str()).collect();
        assert_eq!(signatures, ["sig-b"], "收缩必须杀队首最老、保留队尾新进程");
        drop(guard);
        clear_pool(None);
    }
}
