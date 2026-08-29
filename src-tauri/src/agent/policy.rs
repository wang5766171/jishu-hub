//! 审批策略链（Approval Policy Chain，v0.8.0 需求2 Phase 2）。
//!
//! 把「允许吗？」决策统一为可组合的 waterfall 链（DSH tools/pre-execute 语义
//! 对应物；DEVELOP_READ §6 目标态）。铁律：策略**拥有决策就短路返回
//! Allow/Deny**；否则**必须委托下家**；全链 Delegate = 交给既有交互路径
//! （弹 UI / 无头默认拒绝）。
//!
//! 单调性取舍（02 §2.1）：v1 用顺序折叠——从前往后第一个拥有决策者生效，
//! 天然满足「Deny 不可被后续翻转」；策略顺序即配置语义。
//!
//! 诚实边界：外部 CLI agent 的工具在子进程执行，hub 无法真正 pre-execution
//! 拦截；链挂在**审批决策点**（agent 原生审批请求到达时先过链再决定是否
//! 打扰用户）。`PRE_EXECUTION_INTERCEPTION` 能力位留给进程内/fork 钩子路径
//! （需求1 P-2 将以 beforeToolCall 真实声明）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 决策通道：审批请求来自哪条执行路径。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionChannel {
    /// 交互会话（GUI chat）——Delegate 可弹 UI 打扰用户。
    Interactive,
    /// 无头任务（HeadlessTask）——无用户在场，Delegate 等价拒绝。
    HeadlessTask,
    /// 编排器节点派发——Delegate 等待编排器审批流。
    Orchestrator,
}

/// 审批动作三分类（wire 语义，对齐 normalized::ApprovalKind）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalKindWire {
    Command,
    FileWrite,
    Other,
}

/// 决策上下文：策略唯一输入（不可变快照，策略无副作用）。
#[derive(Debug, Clone)]
pub struct ApprovalContext {
    pub channel: DecisionChannel,
    pub kind: ApprovalKindWire,
    pub session_id: String,
    /// 动作标识（工具名 / 节点标题等，LowRisk 判定用）。
    pub tool: Option<String>,
    pub payload: serde_json::Value,
    /// 编排器通道的事实位（其余通道忽略）：
    /// - `payload_declares`：节点 payload 自身声明需要审批；
    /// - `high_risk`：节点风险判定。
    pub payload_declares: bool,
    pub high_risk: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyDecision {
    Allow,
    Deny,
    Delegate,
}

/// 策略：对上下文给出决策或委托下家。
pub trait ApprovalPolicy: Send + Sync {
    /// 稳定标识（日志/错误文案溯源用）。
    fn id(&self) -> &'static str;
    fn evaluate(&self, ctx: &ApprovalContext) -> PolicyDecision;
}

/// 链 outcome：短路者（含策略 id）或全链委托。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainOutcome {
    Allow(&'static str),
    Deny(&'static str),
    Delegate,
}

/// 策略链：顺序折叠，第一个 Allow/Deny 生效。
#[derive(Clone, Default)]
pub struct PolicyChain {
    policies: Arc<[Box<dyn ApprovalPolicy>]>,
}

impl PolicyChain {
    pub fn new(policies: Vec<Box<dyn ApprovalPolicy>>) -> Self {
        Self {
            policies: policies.into(),
        }
    }

    pub fn empty() -> Self {
        Self::new(Vec::new())
    }

    pub fn evaluate(&self, ctx: &ApprovalContext) -> ChainOutcome {
        for policy in self.policies.iter() {
            match policy.evaluate(ctx) {
                PolicyDecision::Allow => return ChainOutcome::Allow(policy.id()),
                PolicyDecision::Deny => return ChainOutcome::Deny(policy.id()),
                PolicyDecision::Delegate => continue,
            }
        }
        ChainOutcome::Delegate
    }

    pub fn is_empty(&self) -> bool {
        self.policies.is_empty()
    }
}

impl std::fmt::Debug for PolicyChain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PolicyChain")
            .field("len", &self.policies.len())
            .finish()
    }
}

// ---------------------------------------------------------------------------
// 内置策略（v1 五个 + 编排器档位门控两个）
// ---------------------------------------------------------------------------

/// 无头通道拒绝：HeadlessTask → Deny；其余委托。替换 agent_runtime 无头
/// 会话审批的硬编码自动拒绝（挂载点 1 生效后该分支成为防御断言）。
pub struct HeadlessDenyPolicy;

impl ApprovalPolicy for HeadlessDenyPolicy {
    fn id(&self) -> &'static str {
        "headless-deny"
    }
    fn evaluate(&self, ctx: &ApprovalContext) -> PolicyDecision {
        if ctx.channel == DecisionChannel::HeadlessTask {
            PolicyDecision::Deny
        } else {
            PolicyDecision::Delegate
        }
    }
}

/// 低风险自动放行：动作经 tool_view 分类为已知只读类（FileRead/Search/Think）
/// → Allow；未知一律委托弹窗（保守：只放行已知读类）。
pub struct LowRiskAutoAllowPolicy;

impl ApprovalPolicy for LowRiskAutoAllowPolicy {
    fn id(&self) -> &'static str {
        "low-risk-auto-allow"
    }
    fn evaluate(&self, ctx: &ApprovalContext) -> PolicyDecision {
        let Some(tool) = ctx.tool.as_deref() else {
            return PolicyDecision::Delegate;
        };
        match crate::agent::tool_view::classify_name(tool) {
            crate::agent::tool_view::ToolViewKind::FileRead
            | crate::agent::tool_view::ToolViewKind::Search
            | crate::agent::tool_view::ToolViewKind::Think => PolicyDecision::Allow,
            _ => PolicyDecision::Delegate,
        }
    }
}

/// 直接放行（编排器 Never 档 / 测试用）。
pub struct AlwaysAllowPolicy;

impl ApprovalPolicy for AlwaysAllowPolicy {
    fn id(&self) -> &'static str {
        "always-allow"
    }
    fn evaluate(&self, _ctx: &ApprovalContext) -> PolicyDecision {
        PolicyDecision::Allow
    }
}

/// 直接委托（即弹窗/等审批；编排器 Always 档 / 测试用）。
pub struct AlwaysAskPolicy;

impl ApprovalPolicy for AlwaysAskPolicy {
    fn id(&self) -> &'static str {
        "always-ask"
    }
    fn evaluate(&self, _ctx: &ApprovalContext) -> PolicyDecision {
        PolicyDecision::Delegate
    }
}

/// 会话内 Once 记忆：同会话同动作（kind + 规范化 payload 键）已批准过 →
/// Allow；否则委托。v1 为进程内记忆（HashSet），跨重启不保留——编排器通道
/// 的持久化 Once 由 store 支撑的 StoreOncePolicy 承担。
pub struct OnceApprovalPolicy {
    session: String,
    memory: Arc<dyn crate::agent::policy_store::OnceMemory>,
}

impl OnceApprovalPolicy {
    /// 同一会话的多轮审批共享同一 memory 实例（装配助手持有）。
    fn new(session: &str, memory: Arc<dyn crate::agent::policy_store::OnceMemory>) -> Self {
        Self {
            session: session.to_string(),
            memory,
        }
    }

    fn action_key(ctx: &ApprovalContext) -> String {
        // 规范化 payload 键：排序键名拼接（值不进键——同动作不同参数仍算
        // 「已批准过」，与「批准读文件」而非「批准读这个文件」的直觉一致）。
        let mut keys: Vec<String> = ctx
            .payload
            .as_object()
            .map(|obj| obj.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        // 注意含 tool 名（02 §2.3 偏离修正，测试锁定）：文档口径 kind+payload
        // 键会让「批准过 bash」误放行「grep」——同形状不同工具是不同动作。
        format!(
            "{}|{}|{}",
            ctx.tool.as_deref().unwrap_or(""),
            format!("{:?}", ctx.kind),
            keys.join(",")
        )
    }
}

impl ApprovalPolicy for OnceApprovalPolicy {
    fn id(&self) -> &'static str {
        "once-approval"
    }
    fn evaluate(&self, ctx: &ApprovalContext) -> PolicyDecision {
        if ctx.session_id == self.session {
            let key = Self::action_key(ctx);
            if self.memory.has_once(&self.session, &key) {
                return PolicyDecision::Allow;
            }
        }
        PolicyDecision::Delegate
    }
}

/// 记录一次用户批准（resolve_chat_permission 允许后调用）：经默认
/// SQLite 记忆落库，跨重启有效（v0.8.1 需求1 M4）。
pub fn remember_for_session(session_id: &str, ctx: &ApprovalContext) {
    let key = OnceApprovalPolicy::action_key(ctx);
    crate::agent::policy_store::default_memory().remember_once(session_id, &key);
}

// ---------------------------------------------------------------------------
// 到达上下文登记（「始终允许」形状一致回写）：Delegate 弹窗时按 request_id
// 登记链评估所用的原始 ApprovalContext；resolve_chat_permission 取回并以
// 同一形状回写 Once 记忆。action_key 含 tool/kind/payload 键——到达与回写
// 两侧形状不一致 = 记忆永不命中（曾因宽松兜底 tool=None 导致「始终允许」
// 无效）。登记在 resolve 时取回即清理；超时被 agent 自答的残留条目靠
// 容量上限兜底清理。
// ---------------------------------------------------------------------------

fn arrival_contexts() -> &'static Mutex<HashMap<String, ApprovalContext>> {
    static REGISTRY: std::sync::OnceLock<Mutex<HashMap<String, ApprovalContext>>> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Delegate（转弹窗）时登记：三个到达点（Pi 审批型 confirm / ACP
/// request_permission / codex try_policy_or_register）各以 request_id 为键。
pub fn register_arrival_context(request_id: &str, ctx: &ApprovalContext) {
    let mut map = arrival_contexts().lock().unwrap_or_else(|e| e.into_inner());
    if map.len() >= 256 {
        map.clear();
    }
    map.insert(request_id.to_string(), ctx.clone());
}

/// resolve 时取回并清理；未登记（异常路径）返回 None。
pub fn take_arrival_context(request_id: &str) -> Option<ApprovalContext> {
    arrival_contexts()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(request_id)
}

/// 交互会话默认链（挂持久化 Once 记忆，v0.8.1 M4 起跨重启）。
pub fn for_interactive_session(session_id: &str) -> PolicyChain {
    PolicyChain::new(vec![
        Box::new(OnceApprovalPolicy::new(
            session_id,
            crate::agent::policy_store::default_memory(),
        )),
        Box::new(LowRiskAutoAllowPolicy),
    ])
}

/// 变更前审批档链：[LowRisk]——读类自动放行（变更前审批只拦「变更」，
/// 读取不该打扰）；写/执行类**每次**弹窗，不含 Once 记忆（用户裁决：
/// 该档语义是每次变更亲自确认，与智能档的差异就在是否记住「始终允许」）。
pub fn for_ask_always_session(_session_id: &str) -> PolicyChain {
    PolicyChain::new(vec![Box::new(LowRiskAutoAllowPolicy)])
}

/// 按 hub 工具档位选审批链（v0.8.1 修复：完全访问模式审批窗——修前
/// [Once, LowRisk]，完全访问档下部分命令仍弹审批窗——v0.8.0 四档接入只
/// 覆盖了 PiRpc 的 toolApproval 机制，外部 transport 的审批链漏配）。
///
/// - full（缺省，完全访问）→ [AlwaysAllow]：全部自动放行，不打扰
/// - full-approve（变更前审批）→ [LowRisk]：读放行、变更每次弹窗
/// - smart-approve（智能审批）→ [Once, LowRisk]：读放行 + 「始终允许」记忆
/// - readonly → [LowRisk]：ACP/codex 无工具白名单语义（真白名单仅 PiRpc
///   的 --tools 机制），与变更前审批同链——写类弹窗由用户亲自拒绝
/// - 未知值 → 保守走智能审批链
pub fn for_session_tool_mode(agent_id: &str, session_id: &str) -> PolicyChain {
    chain_for_tool_mode(
        crate::hub::load_agent_tool_mode(agent_id).as_deref(),
        session_id,
    )
}

/// 纯函数分派（单测面）：mode 缺省/未知与 full 同为完全访问。
fn chain_for_tool_mode(mode: Option<&str>, session_id: &str) -> PolicyChain {
    match mode {
        Some("full-approve") | Some("readonly") => for_ask_always_session(session_id),
        Some("smart-approve") => for_interactive_session(session_id),
        None | Some("full") | Some(_) => PolicyChain::new(vec![Box::new(AlwaysAllowPolicy)]),
    }
}

/// 无头会话默认链（经注册表挂会话记忆）。
pub fn for_headless_session(session_id: &str) -> PolicyChain {
    PolicyChain::new(vec![
        Box::new(OnceApprovalPolicy::new(
            session_id,
            crate::agent::policy_store::default_memory(),
        )),
        Box::new(LowRiskAutoAllowPolicy),
        Box::new(HeadlessDenyPolicy),
    ])
}

// ---------------------------------------------------------------------------
// 编排器档位门控（挂载点 3；同语义替换 execute.rs 内联 match）
// ---------------------------------------------------------------------------

/// payload 声明门：节点 payload 自身声明需要审批 → Delegate；否则 Allow。
/// （对应内联 match 的 `Never => payload_requires_approval`。）
pub struct PayloadGatePolicy;

impl ApprovalPolicy for PayloadGatePolicy {
    fn id(&self) -> &'static str {
        "payload-gate"
    }
    fn evaluate(&self, ctx: &ApprovalContext) -> PolicyDecision {
        if ctx.payload_declares {
            PolicyDecision::Delegate
        } else {
            PolicyDecision::Allow
        }
    }
}

/// 高风险门：high_risk → Delegate；否则 Allow（对应 `OnHighRisk => high_risk`）。
pub struct HighRiskGatePolicy;

impl ApprovalPolicy for HighRiskGatePolicy {
    fn id(&self) -> &'static str {
        "high-risk-gate"
    }
    fn evaluate(&self, ctx: &ApprovalContext) -> PolicyDecision {
        if ctx.high_risk {
            PolicyDecision::Delegate
        } else {
            PolicyDecision::Allow
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(channel: DecisionChannel, tool: Option<&str>) -> ApprovalContext {
        ApprovalContext {
            channel,
            kind: ApprovalKindWire::Other,
            session_id: "s1".into(),
            tool: tool.map(str::to_string),
            payload: serde_json::json!({}),
            payload_declares: false,
            high_risk: false,
        }
    }

    #[test]
    fn chain_folds_in_order_and_delegates_when_all_delegate() {
        let chain = PolicyChain::new(vec![
            Box::new(AlwaysAskPolicy),
            Box::new(LowRiskAutoAllowPolicy),
        ]);
        // 只读工具：always-ask 委托 → low-risk 放行。
        assert_eq!(
            chain.evaluate(&ctx(DecisionChannel::Interactive, Some("read"))),
            ChainOutcome::Allow("low-risk-auto-allow")
        );
        // 未知工具：全链委托。
        assert_eq!(
            chain.evaluate(&ctx(DecisionChannel::Interactive, Some("bash"))),
            ChainOutcome::Delegate
        );
        // 空链全委托。
        assert_eq!(
            PolicyChain::empty().evaluate(&ctx(DecisionChannel::Interactive, None)),
            ChainOutcome::Delegate
        );
    }

    #[test]
    fn deny_cannot_be_flipped_by_later_policies() {
        let chain = PolicyChain::new(vec![
            Box::new(HeadlessDenyPolicy),
            Box::new(AlwaysAllowPolicy),
        ]);
        assert_eq!(
            chain.evaluate(&ctx(DecisionChannel::HeadlessTask, Some("read"))),
            ChainOutcome::Deny("headless-deny")
        );
        // 同链对交互通道：deny 委托 → always-allow。
        assert_eq!(
            chain.evaluate(&ctx(DecisionChannel::Interactive, Some("bash"))),
            ChainOutcome::Allow("always-allow")
        );
    }

    #[test]
    fn headless_deny_only_targets_headless_channel() {
        let p = HeadlessDenyPolicy;
        assert_eq!(p.evaluate(&ctx(DecisionChannel::HeadlessTask, None)), PolicyDecision::Deny);
        assert_eq!(p.evaluate(&ctx(DecisionChannel::Interactive, None)), PolicyDecision::Delegate);
        assert_eq!(p.evaluate(&ctx(DecisionChannel::Orchestrator, None)), PolicyDecision::Delegate);
    }

    #[test]
    fn low_risk_only_allows_known_readonly_kinds() {
        let p = LowRiskAutoAllowPolicy;
        for tool in ["read", "grep", "glob", "thinking"] {
            assert_eq!(p.evaluate(&ctx(DecisionChannel::Interactive, Some(tool))), PolicyDecision::Allow, "{tool}");
        }
        for tool in ["bash", "write", "edit", "unknown", "webfetch"] {
            assert_eq!(p.evaluate(&ctx(DecisionChannel::Interactive, Some(tool))), PolicyDecision::Delegate, "{tool}");
        }
        // 无工具名 → 委托（保守）。
        assert_eq!(p.evaluate(&ctx(DecisionChannel::Interactive, None)), PolicyDecision::Delegate);
    }

    #[test]
    fn once_memory_hits_within_same_session_and_action_shape() {
        // v0.8.1 M4：Once 记忆经 OnceMemory trait 注入（测试用内存实现，
        // 不写真实 approval.db）。
        let memory: std::sync::Arc<dyn crate::agent::policy_store::OnceMemory> =
            std::sync::Arc::new(crate::agent::policy_store::InMemoryOnceMemory::new());
        let chain = PolicyChain::new(vec![
            Box::new(OnceApprovalPolicy::new("s1", memory.clone())),
            Box::new(LowRiskAutoAllowPolicy),
        ]);
        // 首次：委托。
        let first = ctx(DecisionChannel::Interactive, Some("bash"));
        assert_eq!(chain.evaluate(&first), ChainOutcome::Delegate);
        // 记录批准后：同会话同动作形状 → once 命中放行。
        memory.remember_once("s1", &OnceApprovalPolicy::action_key(&first));
        assert_eq!(chain.evaluate(&first), ChainOutcome::Allow("once-approval"));
        // 不同会话不共享记忆。
        let other_session = ApprovalContext { session_id: "s2".into(), ..ctx(DecisionChannel::Interactive, Some("bash")) };
        assert_eq!(chain.evaluate(&other_session), ChainOutcome::Delegate);
        // 只读工具即使无记忆也被 low-risk 放行（链顺序语义）。
        assert_eq!(
            chain.evaluate(&ctx(DecisionChannel::Interactive, Some("grep"))),
            ChainOutcome::Allow("low-risk-auto-allow")
        );
    }

    #[test]
    fn headless_task_chain_denies_unknown_and_allows_readonly() {
        let chain = PolicyChain::new(vec![
            Box::new(OnceApprovalPolicy::new(
                "s1",
                std::sync::Arc::new(crate::agent::policy_store::InMemoryOnceMemory::new()),
            )),
            Box::new(LowRiskAutoAllowPolicy),
            Box::new(HeadlessDenyPolicy),
        ]);
        assert_eq!(
            chain.evaluate(&ctx(DecisionChannel::HeadlessTask, Some("read"))),
            ChainOutcome::Allow("low-risk-auto-allow")
        );
        assert_eq!(
            chain.evaluate(&ctx(DecisionChannel::HeadlessTask, Some("bash"))),
            ChainOutcome::Deny("headless-deny")
        );
    }

    #[test]
    fn ask_always_chain_allows_reads_and_ignores_once_memory() {
        // 变更前审批档 = [LowRisk]：读类放行（只拦「变更」）；写/执行类每次
        // 委托弹窗——即使此前写入过「始终允许」记忆（该档链不挂 Once）。
        let chain = for_ask_always_session("s1");
        assert_eq!(
            chain.evaluate(&ctx(DecisionChannel::Interactive, Some("read"))),
            ChainOutcome::Allow("low-risk-auto-allow")
        );
        let write = ctx(DecisionChannel::Interactive, Some("bash"));
        assert_eq!(chain.evaluate(&write), ChainOutcome::Delegate);
        remember_for_session("s1", &write);
        assert_eq!(chain.evaluate(&write), ChainOutcome::Delegate);
    }

    #[test]
    fn arrival_context_roundtrip_makes_always_allow_hit() {
        // 真实链路：到达（Delegate 弹窗）登记 → 「始终允许」取回同形状回写 →
        // 同动作再次到达经 Once 命中。形状（tool/kind/payload 键）任一侧漂移
        // 记忆即失效——曾因回写侧 tool=None 兜底导致「始终允许」无效。
        let mut arrival = ctx(DecisionChannel::Interactive, Some("bash"));
        arrival.payload = serde_json::json!({ "tool": "bash", "summary": "rm -rf", "mode": "smart" });
        let chain = for_interactive_session("s1");
        assert_eq!(chain.evaluate(&arrival), ChainOutcome::Delegate);
        register_arrival_context("req-1", &arrival);
        // resolve「始终允许」：取回原始上下文回写（chat.rs 同逻辑）。
        let replayed = take_arrival_context("req-1").expect("arrival registered");
        remember_for_session(&replayed.session_id, &replayed);
        assert_eq!(chain.evaluate(&arrival), ChainOutcome::Allow("once-approval"));
        // 登记已被取走清理；同动作不同工具仍委托（action_key 含工具名）。
        assert!(take_arrival_context("req-1").is_none());
        let mut other_tool = arrival.clone();
        other_tool.tool = Some("write".into());
        other_tool.payload = serde_json::json!({ "tool": "write", "summary": "x", "mode": "smart" });
        assert_eq!(chain.evaluate(&other_tool), ChainOutcome::Delegate);
    }

    #[test]
    fn orchestrator_gates_match_inline_match_semantics() {
        // Never：payload 未声明 → 放行；声明 → 委托。
        let never = PolicyChain::new(vec![Box::new(PayloadGatePolicy)]);
        let mut c = ctx(DecisionChannel::Orchestrator, None);
        assert_eq!(never.evaluate(&c), ChainOutcome::Allow("payload-gate"));
        c.payload_declares = true;
        assert_eq!(never.evaluate(&c), ChainOutcome::Delegate);
        // OnHighRisk：低风险放行，高风险委托。
        let on_high = PolicyChain::new(vec![Box::new(HighRiskGatePolicy)]);
        let mut c2 = ctx(DecisionChannel::Orchestrator, None);
        assert_eq!(on_high.evaluate(&c2), ChainOutcome::Allow("high-risk-gate"));
        c2.high_risk = true;
        assert_eq!(on_high.evaluate(&c2), ChainOutcome::Delegate);
        // Always：空链委托。
        assert_eq!(
            PolicyChain::empty().evaluate(&ctx(DecisionChannel::Orchestrator, None)),
            ChainOutcome::Delegate
        );
    }
}
