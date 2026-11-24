use serde::{Deserialize, Serialize};

bitflags::bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    pub struct AgentCapabilities: u64 {
        const RESUME_BY_ID         = 1 << 0;
        const RESUME_LATEST        = 1 << 1;
        const RESUME_PICKER        = 1 << 2;
        const SESSION_FORK         = 1 << 3;
        const SESSION_LIST         = 1 << 4;
        const SESSION_DELETE       = 1 << 5;
        const SESSION_EXPORT       = 1 << 6;
        const SESSION_IMPORT       = 1 << 7;

        const IMAGE_INPUT          = 1 << 10;
        const FILE_INPUT           = 1 << 11;
        const STDIN_PROMPT         = 1 << 12;

        const STREAM_TEXT_DELTA    = 1 << 20;
        const STREAM_TOOL_CALLS    = 1 << 21;
        const STREAM_THINKING      = 1 << 22;
        const PARTIAL_MESSAGE      = 1 << 23;

        const ABORT                = 1 << 30;
        const APPROVAL_REQUEST     = 1 << 31;
        /// Transport can intercept individual tool calls BEFORE execution and
        /// pause for an orchestrator decision (P0-1 permission proxy). Adapters
        /// declare this only once their transport actually implements pre-execution
        /// interception + same-native-request resume.
        const PRE_EXECUTION_INTERCEPTION = 1 << 32;
        /// Manual + automatic context compaction (v0.7.4 需求1 A3). Only
        /// transports with a native compact mechanism (Pi RPC) declare this.
        const CONTEXT_COMPACT = 1 << 33;
        /// Supports the task work mode (orchestrated task-graph sessions;
        /// v0.7.4 需求3 M2). Replaces the hardcoded `agentId === "jishu-self"`
        /// gating in the chat page with a capability check.
        const TASK_MODE = 1 << 34;
        /// New-session first connect may adopt a pre-warmed RPC process from
        /// the preconnect pool（评审 P2-⑤ 用户裁决：能力化替代 agent id 分支——
        /// preconnect 池经 registry 查此位决定接管/补池对象，不再硬编码
        /// agent id）。仅限 RPC transport 可池化暖启的 agent 声明。
        const PRECONNECTABLE = 1 << 35;
        /// 用户消息由通道自己落盘，并把「已落盘」回报给 hub（pi 通道的
        /// `message_end(role=user)`）——hub 侧的发送防丢账因此**可对账**：
        /// 入口记账、落盘回执销账。v0.9.8 评审修复轮 R1-2：取代 send_message
        /// 里按智能体名字判断「是否记账」的硬分支（DEVELOP_READ §7）。无落盘
        /// 回执的通道（ACP）不声明——记账会永假「未送达」。
        const PERSISTED_RECEIPT = 1 << 36;

        const CONFIG_GLOBAL        = 1 << 40;
        const CONFIG_PROJECT       = 1 << 41;
        const CONFIG_BACKUP        = 1 << 42;
        const CONFIG_TEMPLATES     = 1 << 43;

        const SUBAGENT_DISPATCH    = 1 << 50;
        const SUBAGENT_RECEIVE     = 1 << 51;
        const TASK_PLANNING        = 1 << 52;
        const TASK_SUPERVISION     = 1 << 53;

        /// Session history is persisted on the hub side (manifest agents with
        /// store="hub"; v0.8.1 需求1 M2). The chat page's turn_complete hook
        /// calls `persist_agent_turn` only when this bit is declared —
        /// declaration-driven, no agentId branching.
        const HUB_SESSION_PERSIST  = 1 << 54;

        const RPC_BIDIRECTIONAL    = 1 << 60;
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct AgentHealth {
    pub installed: bool,
    pub version: Option<String>,
    pub error: Option<String>,
    pub binary_path: Option<String>,
    pub last_checked_at: i64,
}
