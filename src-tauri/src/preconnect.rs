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
//!   参数，池进程无法事后补挂，天然不接管（签名比对也兜底）；仅
//!   jishu-self + PiRpc（用户明确「只针对 jishu agent」）；
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
/// jishu agent（PiRpc transport）——唯一预连对象（用户明确范围）。
const TARGET_AGENT_ID: &str = "jishu-self";
const DEFAULT_MAX_POOL: usize = 3;
const MAX_POOL_LIMIT: usize = 8;

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

/// 按「新会话首连」形态构建 jishu-self 的启动 spec（session_id=None → 无
/// --session-id，与真实首连逐参数一致；tools 白名单/模型 args/envs 全跟
/// 随当前配置）+ 签名。registry 缺 agent/构建失败返回 None（调用方放弃补池）。
fn build_spec(
    registry: &AgentRegistry,
    project_path: &str,
) -> Option<(crate::agent::AcpCommandSpec, String)> {
    let request = crate::agent_runtime::AgentTurnRequest {
        agent_id: TARGET_AGENT_ID.to_string(),
        project_path: project_path.to_string(),
        session_id: None,
        message: String::new(),
        timeout_secs: 0,
        model_override: None,
    };
    let prepared = agent_runtime::prepare_gui_turn(registry, request).ok()?;
    let agent_runtime::PreparedGuiTurn::Acp(acp) = &prepared else {
        return None;
    };
    let signature = agent_runtime::acp_command_signature(&acp.command)?;
    Some((acp.command.clone(), signature))
}

/// 后台补池任务：spawn 到目标条数。spawn 后重新锁池插入——若插入时焦点
/// 已切走（用户快速切标签），立刻杀掉刚 spawn 的进程并停手（不再补旧项目）。
fn fill_async(registry: std::sync::Arc<AgentRegistry>, project_path: String, want: usize) {
    tauri::async_runtime::spawn(async move {
        for _ in 0..want {
            // 每次 spawn 前用最新配置构建（长池龄期间用户可能改模型/工具面）。
            let Some((spec, signature)) = build_spec(&registry, &project_path) else {
                log::warn!("[preconnect] build spec failed for {project_path}, skip refill");
                return;
            };
            let mut child =
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
            let mut guard = pool().lock().unwrap_or_else(|e| e.into_inner());
            if guard.focus.as_deref() != Some(project_path.as_str()) {
                // 焦点已变：杀掉这个刚 spawn 的，停止补旧项目。
                let _ = child.start_kill();
                return;
            }
            guard.entries.push(Entry {
                project_path: project_path.clone(),
                signature,
                child,
                created_at: Instant::now(),
            });
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
        // 池深收缩（maxPool 调小）：杀掉超额条目（队尾新进程保留）。
        if live > s.max_pool {
            let excess = live - s.max_pool;
            for _ in 0..excess {
                if let Some(mut entry) = guard.entries.pop() {
                    let _ = entry.child.start_kill();
                }
            }
            log::info!("[preconnect] pool shrunk: killed {excess} excess entrie(s)");
        }
        s.max_pool.saturating_sub(guard.entries.len())
    };
    if want > 0 {
        fill_async(registry.clone(), project_path.to_string(), want);
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
/// 匹配（jishu-self × PiRpc × 无 native_session_id × 同项目 × 同签名 × 进程
/// 活着）弹出条目返回 child；任何不匹配返回 None（调用方回落正常 spawn）。
/// 同项目但签名漂移的死配置条目顺手杀——配置变了进程即废。
pub fn take_for_turn(turn: &PreparedAcpTurn) -> Option<tokio::process::Child> {
    if turn.transport != crate::agent::TransportSurface::PiRpc
        || turn.agent_id != TARGET_AGENT_ID
        || turn.native_session_id.is_some()
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
}
