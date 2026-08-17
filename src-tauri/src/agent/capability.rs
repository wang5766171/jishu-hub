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

        const CONFIG_GLOBAL        = 1 << 40;
        const CONFIG_PROJECT       = 1 << 41;
        const CONFIG_BACKUP        = 1 << 42;
        const CONFIG_TEMPLATES     = 1 << 43;

        const SUBAGENT_DISPATCH    = 1 << 50;
        const SUBAGENT_RECEIVE     = 1 << 51;
        const TASK_PLANNING        = 1 << 52;
        const TASK_SUPERVISION     = 1 << 53;

        const RPC_BIDIRECTIONAL    = 1 << 60;
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentManifest {
    pub display_name: String,
    pub icon: String,
    pub logo_path: Option<String>,
    pub description: String,
    pub homepage: Option<String>,
    pub install_hint: Option<String>,
    pub config_dir_hint: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentHealth {
    pub installed: bool,
    pub version: Option<String>,
    pub error: Option<String>,
    pub binary_path: Option<String>,
    pub last_checked_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetailedAgentInfo {
    pub id: String,
    pub manifest: AgentManifest,
    pub capabilities: AgentCapabilities,
    pub health: AgentHealth,
}
