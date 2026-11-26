//! pi_rpc_runtime 子模块（v0.9.8 评审修复轮 R2 拆出）：回合看门狗的窗口与
//! 判定规则。v0.9.6 需求6 F2 起就是一组不持有循环状态的纯函数——输入输出都
//! 是值，连接循环按它算期限、单测直接调。放在这里，主文件只留连接循环与
//! 状态机（DEVELOP_READ §12 文件规模）。

use std::time::Duration;

/// v0.9.6 需求6 F2：回合分级看门狗相位。
/// 取代 v0.9.5 的单闹钟 `prompt_ack_at`（20s，response 到达即解除——实测该
/// 等价不成立：pi 的 prompt response success 只代表 preflight「started」，
/// 回合真正启动（压缩预检/before_agent_start/LLM 首请求）之前的静默无人
/// 看护，命中即永停 Prompting、前端永「思考中」且消息不落盘）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum WatchdogPhase {
    /// prompt 已写 stdin，等 rpc response。response 之前 pi 可能先跑自动压缩
    /// 预检（summarize 的 LLM chunk 不外发 stdout——对 hub 整段静默，大上下文
    /// +思考模型分钟级且无 transport 上限约束）+ auth 刷新（≤15s）+
    /// before_agent_start 钩子（内置 MCP ≤10s；第三方理论无界）→ 宽窗。
    AwaitResponse,
    /// response(started) 已到，等首个回合事件。started→agent_start/turn_start
    /// 之间无 I/O（仅扩展微任务链，MCP 重连秒级）→ 紧凑窗。
    AwaitTurnStart,
}

/// v0.9.6 需求6 F2：各相位窗口（依据见 WatchdogPhase 注释；触发均出
/// recoverable Error 引导重发，devlog 留证可调窗）。
const WATCHDOG_AWAIT_RESPONSE: Duration = Duration::from_secs(300);
const WATCHDOG_AWAIT_TURN_START: Duration = Duration::from_secs(15);

/// v0.9.6 需求6 F2：窗口选择（纯函数，供单测）。
/// v0.9.6 需求9 哲学修正（2026-11-07 评审 P2-1 清理）：原 in_compaction
/// 宽窄窗参数随 InTurn 相位废除而失去消费者——删除死参数，窗口仅由相位决定。
pub(super) fn turn_watchdog_window(phase: WatchdogPhase) -> Duration {
    match phase {
        WatchdogPhase::AwaitResponse => WATCHDOG_AWAIT_RESPONSE,
        WatchdogPhase::AwaitTurnStart => WATCHDOG_AWAIT_TURN_START,
    }
}

/// v0.9.6 需求6 F2：事件驱动的相位转移（纯函数，供单测）。
/// （需求9 哲学修正前的旧语义「升 InTurn/宽窄窗」已废除——见下方裁决注释。）
/// v0.9.6 需求9 用户哲学裁决（2026-11-06）：「当时永远思考中不是 pi 死了，
/// 更像是消息没到 pi……坚决的相信 pi 没问题」。看门狗职责收窄为**投递确认**
/// ——回合一旦启动（首个回合事件到达）= 投递成功铁证，解除看门狗，此后
/// 无条件信任 pi 直到收口（agent_settled/turn_complete）或进程退出（EOF）。
/// 回合内的长静默（LLM 思考/工具执行/等待作答）全部是 pi 的正常形态，
/// hub 不再猜测、不再判死（InTurn 相位废除——它按「pi 可能挂死」的假设
/// 设计，实际病根在 hub 投递链路，且已两度误杀：等待作答/长构建）。
pub(super) fn watchdog_phase_on_event(
    _phase: WatchdogPhase,
    _event_type: &str,
) -> Option<WatchdogPhase> {
    None // 调用点据此解除看门狗（见事件处理处）
}

/// v0.9.8 需求7 补充轮：空闲回收判定——状态 Idle、引擎没有在压缩、且本轮到期
/// 的正是空闲期限。压缩期间引擎静默（摘要生成可持续数分钟），状态虽是 Idle
/// 但不是空闲：不回收。
pub(super) fn idle_reap_due(
    is_idle: bool,
    in_compaction: bool,
    idle_deadline: tokio::time::Instant,
    next_deadline: tokio::time::Instant,
) -> bool {
    is_idle && !in_compaction && idle_deadline <= next_deadline
}
