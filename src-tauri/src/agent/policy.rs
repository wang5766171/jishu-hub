//! 审批策略链（Approval Policy Chain，v0.8.0 需求2 Phase 2）。
//!
//! 把「允许吗？」决策统一为可组合的 waterfall 链（DSH tools/pre-execute 语义
//! 对应物；DEVELOP_READ §11 目标态）。铁律：策略**拥有决策就短路返回
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

use std::collections::HashSet;
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
    memory: Arc<Mutex<HashSet<String>>>,
}

impl OnceApprovalPolicy {
    /// 同一会话的多轮审批共享同一 memory 实例（装配助手持有）。
    fn new(session: &str, memory: Arc<Mutex<HashSet<String>>>) -> Self {
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
            if let Ok(mem) = self.memory.lock() {
                if mem.contains(&key) {
                    return PolicyDecision::Allow;
                }
            }
        }
        PolicyDecision::Delegate
    }
}

/// 记录一次批准（resolve_chat_permission 允许后调用，供 Once 命中）。
pub fn remember_approval(chain_memory: &ChainMemory, ctx: &ApprovalContext) {
    let key = OnceApprovalPolicy::action_key(ctx);
    if let Ok(mut mem) = chain_memory.0.lock() {
        mem.insert(key);
    }
}

/// 会话级 Once 记忆句柄（装配时创建，随链共享）。
pub struct ChainMemory(Arc<Mutex<HashSet<String>>>);

impl Default for ChainMemory {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(HashSet::new())))
    }
}

// ---------------------------------------------------------------------------
// 装配助手：三通道默认链（02 §2.3）
// ---------------------------------------------------------------------------

/// chat（Interactive）默认链：[Once, LowRisk] → Delegate 弹 UI。
pub fn for_chat(session_id: &str, memory: ChainMemory) -> (PolicyChain, ChainMemory) {
    let chain = PolicyChain::new(vec![
        Box::new(OnceApprovalPolicy::new(session_id, memory.0.clone())),
        Box::new(LowRiskAutoAllowPolicy),
    ]);
    (chain, memory)
}

/// 无头任务默认链：[Once, LowRisk, HeadlessDeny]。
pub fn for_headless_task(session_id: &str, memory: ChainMemory) -> (PolicyChain, ChainMemory) {
    let chain = PolicyChain::new(vec![
        Box::new(OnceApprovalPolicy::new(session_id, memory.0.clone())),
        Box::new(LowRiskAutoAllowPolicy),
        Box::new(HeadlessDenyPolicy),
    ]);
    (chain, memory)
}

// ---------------------------------------------------------------------------
// 会话级 Once 记忆注册表（跨命令回填）：spawn 装配与 resolve_chat_permission
// 分属不同调用域，经此按 session_id 共享同一记忆实例（进程生命周期）。
// ---------------------------------------------------------------------------

use std::collections::HashMap;

fn once_memories() -> &'static Mutex<HashMap<String, Arc<Mutex<HashSet<String>>>>> {
    static REGISTRY: std::sync::OnceLock<Mutex<HashMap<String, Arc<Mutex<HashSet<String>>>>>> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn memory_for_session(session_id: &str) -> Arc<Mutex<HashSet<String>>> {
    let reg = once_memories();
    let mut map = reg.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(HashSet::new())))
        .clone()
}

/// 记录一次用户批准（resolve_chat_permission 允许后调用）。
pub fn remember_for_session(session_id: &str, ctx: &ApprovalContext) {
    let key = OnceApprovalPolicy::action_key(ctx);
    let memory = memory_for_session(session_id);
    if let Ok(mut mem) = memory.lock() {
        mem.insert(key);
    };
}

/// 交互会话默认链（经注册表挂会话记忆）。
pub fn for_interactive_session(session_id: &str) -> PolicyChain {
    let memory = memory_for_session(session_id);
    PolicyChain::new(vec![
        Box::new(OnceApprovalPolicy::new(session_id, memory)),
        Box::new(LowRiskAutoAllowPolicy),
    ])
}

/// 无头会话默认链（经注册表挂会话记忆）。
pub fn for_headless_session(session_id: &str) -> PolicyChain {
    let memory = memory_for_session(session_id);
    PolicyChain::new(vec![
        Box::new(OnceApprovalPolicy::new(session_id, memory)),
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
        let memory = ChainMemory::default();
        let (chain, memory) = {
            let (c, m) = for_chat("s1", memory);
            (c, m)
        };
        // 首次：委托。
        let first = ctx(DecisionChannel::Interactive, Some("bash"));
        assert_eq!(chain.evaluate(&first), ChainOutcome::Delegate);
        // 记录批准后：同会话同动作形状 → once 命中放行。
        remember_approval(&memory, &first);
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
        let (chain, _m) = for_headless_task("s1", ChainMemory::default());
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
