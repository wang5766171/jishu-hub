use clap::{Parser, Subcommand};

/// Jishu — jishu-self agent + multi-agent orchestrator CLI.
#[derive(Parser, Debug)]
#[command(
    name = "jishu-cli",
    version = env!("CARGO_PKG_VERSION"),
    about = "Jishu agent and multi-agent orchestrator"
)]
pub struct Cli {
    /// Output results as JSON-lines.
    #[arg(long, global = true)]
    pub json: bool,

    /// Set log level (trace, debug, info, warn, error).
    #[arg(long, global = true, value_name = "LEVEL")]
    pub log: Option<String>,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Manage agents.
    Agents {
        #[command(subcommand)]
        action: AgentAction,
    },

    /// Chat with an agent.
    Chat {
        #[command(subcommand)]
        action: ChatAction,
    },

    /// Run diagnostics.
    Doctor {
        /// Attempt to fix issues automatically.
        #[arg(long)]
        fix: bool,

        /// Output format (text, json).
        #[arg(long, default_value = "text")]
        format: String,

        /// Only run a specific check.
        #[arg(long)]
        only: Option<String>,
    },

    /// Manage plans.
    Plan {
        #[command(subcommand)]
        action: PlanAction,
    },

    /// Manage tasks within a plan.
    Task {
        #[command(subcommand)]
        action: TaskAction,
    },

    /// Query events.
    Event {
        #[command(subcommand)]
        action: EventAction,
    },

    /// Execute a single prompt (non-interactive).
    Run {
        /// The prompt to send.
        prompt: String,

        /// Agent to use.
        #[arg(long)]
        agent: Option<String>,

        /// Project path.
        #[arg(long, default_value = ".")]
        project: String,
    },

    /// Manage model configurations (read-only — full CRUD via GUI).
    Model {
        #[command(subcommand)]
        action: ModelAction,
    },

    /// Daemon management.
    Daemon {
        #[command(subcommand)]
        action: DaemonAction,
    },

    /// Evolve the current project using an orchestrator plan.
    Evolve {
        /// Path to the plan file.
        #[arg(long)]
        plan: Option<String>,

        /// Project path.
        #[arg(long, default_value = ".")]
        project: String,

        /// Dry run: show what would be done without executing.
        #[arg(long)]
        dry_run: bool,
    },

    /// ACP (Agent Communication Protocol) bridge.
    Acp {
        #[command(subcommand)]
        action: AcpAction,
    },

    /// Manage plugins (v0.8.1 需求4：add/list/remove/enable/disable).
    Plugins {
        #[command(subcommand)]
        action: PluginAction,
    },

    /// Tool-plugin CLI artifacts (v0.8.1 需求10：lock-requirement/commit-plan).
    #[command(name = "task-artifact")]
    TaskArtifact {
        #[command(subcommand)]
        action: TaskArtifactAction,
    },

    /// Project memory KV (v0.8.1 需求8 P1：跨 agent 共享的项目记忆).
    Memory {
        #[command(subcommand)]
        action: MemoryAction,
    },

    /// hub MCP 聚合 server 与四家注入（v0.9.0 需求1：serve/inject/remove/status）.
    Mcp {
        #[command(subcommand)]
        action: McpAction,
    },

    /// Skill 分发服务（v0.9.0 需求20：deploy/remove/status）.
    Skill {
        #[command(subcommand)]
        action: SkillAction,
    },
}

// ── Agent ────────────────────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum AgentAction {
    /// List registered agents.
    List,

    /// Show agent health status.
    Health {
        /// Agent identifier.
        agent: Option<String>,
    },

    /// Probe an agent and refresh cached health.
    Probe {
        /// Agent identifier.
        agent: String,
    },
}

// ── Chat ─────────────────────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum ChatAction {
    /// Start an interactive chat session.
    Start {
        /// Agent identifier.
        #[arg(long, default_value = "jishu-self")]
        agent: String,

        /// Project path.
        #[arg(long, default_value = ".")]
        project: String,
    },

    /// Send a message to an agent.
    Send {
        /// Agent identifier.
        #[arg(long, default_value = "jishu-self")]
        agent: String,

        /// Project path.
        #[arg(long, default_value = ".")]
        project: String,

        /// Message text.
        #[arg(long)]
        message: Option<String>,

        /// Read message from file.
        #[arg(long)]
        message_file: Option<String>,

        /// Read message from stdin.
        #[arg(long)]
        message_stdin: bool,

        /// Session ID to resume.
        #[arg(long)]
        session: Option<String>,

        /// Stream output as JSON-lines.
        #[arg(long)]
        stream_json: bool,

        /// Don't wait for completion (print PID and exit).
        #[arg(long)]
        no_wait: bool,
    },

    /// Resume an interactive session.
    Resume {
        /// Session ID.
        id: String,
    },

    /// Abort a running session.
    Abort {
        /// Session ID.
        id: String,
    },

    /// Tail session output.
    Tail {
        /// Session ID.
        id: String,
    },
}

// ── Plan ─────────────────────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum PlanAction {
    /// Create a new plan.
    Create {
        /// Plan name.
        name: String,

        /// Plan description.
        #[arg(long)]
        description: Option<String>,
    },

    /// List all plans.
    List,

    /// Show plan details and task status.
    Show {
        /// Plan ID.
        plan_id: String,
    },

    /// Delete a plan.
    Delete {
        /// Plan ID.
        plan_id: String,
    },
}

// ── Task ─────────────────────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum TaskAction {
    /// Add a task to a plan.
    Add {
        /// Plan ID.
        #[arg(long)]
        plan: String,

        /// Task description.
        description: String,
    },

    /// Update task status.
    Update {
        /// Task ID.
        task_id: String,

        /// New status (pending, in-progress, done, failed).
        #[arg(long)]
        status: String,
    },

    /// List tasks in a plan.
    List {
        /// Plan ID.
        plan_id: String,
    },

    /// Find a task instance by session ID.
    Find {
        /// Session ID to look up.
        #[arg(long)]
        session: String,

        /// Project root path (defaults to current directory).
        #[arg(long, default_value = ".")]
        project: String,
    },
}

// ── Event ────────────────────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum EventAction {
    /// Query events with optional filters.
    Query {
        /// Filter by event type.
        #[arg(long)]
        r#type: Option<String>,

        /// Filter by agent.
        #[arg(long)]
        agent: Option<String>,

        /// Limit number of results.
        #[arg(long, default_value = "50")]
        limit: usize,
    },

    /// Tail events in real time.
    Tail {
        /// Filter by event type.
        #[arg(long)]
        r#type: Option<String>,
    },
}

// ── Model ────────────────────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum ModelAction {
    /// List configured models.
    List,

    /// Test a model connection.
    Test {
        /// Target model as `<provider>/<model>` (see `list`).
        target: String,
    },
}

// ── Daemon ───────────────────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum DaemonAction {
    /// Start the daemon.
    Start {
        /// Run in the background.
        #[arg(long)]
        detach: bool,
    },

    /// Stop the daemon.
    Stop,

    /// Show daemon status.
    Status,

    /// Restart the daemon.
    Restart,
}

// ── ACP ──────────────────────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum AcpAction {
    /// Start an ACP session.
    Start {
        /// Working directory for the session.
        #[arg(long)]
        cwd: Option<String>,

        /// Model to use.
        #[arg(long)]
        model: Option<String>,

        /// Path to log file.
        #[arg(long)]
        log_file: Option<String>,
    },

    /// Stop an ACP session.
    Stop {
        /// Session ID.
        session_id: String,
    },

    /// List active ACP sessions.
    List,
}

// ── Plugins（v0.8.1 需求4）────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum PluginAction {
    /// Install a plugin from a local TOML manifest file (validated on install).
    Add {
        /// Path to the plugin manifest TOML.
        path: String,
    },

    /// List all plugins (builtin + manifest agents + tool plugins).
    List,

    /// Remove a non-core plugin by id.
    Remove {
        /// Plugin identifier.
        id: String,
    },

    /// Enable a plugin.
    Enable {
        /// Plugin identifier.
        id: String,
    },

    /// Disable a plugin.
    Disable {
        /// Plugin identifier.
        id: String,
    },
}

// ── Task artifact（v0.8.1 需求10：自适应插件 CLI 形态）───────────────────────

#[derive(Subcommand, Debug)]
pub enum TaskArtifactAction {
    /// Lock the discussed requirements into structured artifacts.
    #[command(name = "lock-requirement")]
    LockRequirement {
        /// Requirement title.
        #[arg(long)]
        title: String,

        /// Goal statement.
        #[arg(long)]
        goal: String,

        /// Scope items, semicolon-separated.
        #[arg(long)]
        scope: String,

        /// Acceptance criteria, semicolon-separated.
        #[arg(long)]
        acceptance: String,

        /// Project path.
        #[arg(long, default_value = ".")]
        project: String,

        /// Task id (defaults to free-<unix-ts>).
        #[arg(long)]
        task_id: Option<String>,
    },

    /// Commit a flow plan proposal as structured artifacts.
    #[command(name = "commit-plan")]
    CommitPlan {
        /// Plan nodes as JSON.
        #[arg(long)]
        nodes: String,

        /// Project path.
        #[arg(long, default_value = ".")]
        project: String,

        /// Task id (defaults to free-<unix-ts>).
        #[arg(long)]
        task_id: Option<String>,
    },
}

// ── Memory（v0.8.1 需求8 P1：项目记忆 KV）────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum MemoryAction {
    /// Set a key-value pair for a project.
    Set {
        /// Project path (absolute, or "." for cwd).
        #[arg(long, default_value = ".")]
        project: String,

        /// Key.
        #[arg(long)]
        key: String,

        /// Value.
        #[arg(long)]
        value: String,
    },

    /// Get a value by key (prints the value, or null).
    Get {
        /// Project path.
        #[arg(long, default_value = ".")]
        project: String,

        /// Key.
        #[arg(long)]
        key: String,
    },

    /// List all entries for a project.
    List {
        /// Project path.
        #[arg(long, default_value = ".")]
        project: String,
    },

    /// Delete a key.
    Delete {
        /// Project path.
        #[arg(long, default_value = ".")]
        project: String,

        /// Key.
        #[arg(long)]
        key: String,
    },
}

// ── Mcp（v0.9.0 需求1 P2）────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum McpAction {
    /// Run the hub MCP aggregation server over stdio (spawned by agents).
    Serve,

    /// Ensure the `jishu-hub` entry exists in all four agents' MCP configs
    /// (only when MCP-declaring plugins are enabled; same logic as app sync).
    Inject,

    /// Remove the `jishu-hub` entry from all four agents' MCP configs.
    Remove,

    /// Show current sync status (plugin declarations + four-agent entries).
    Status,
}

// ── Skill（v0.9.0 需求20）────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum SkillAction {
    /// Force-deploy enabled [skill] plugins to agent skill dirs
    /// (explicit command bypasses the resolver gate).
    Deploy,

    /// Remove all hub-deployed skill dirs from agent skill roots.
    Remove,

    /// Show skill resolver state, targets, and deployed list.
    Status,
}
