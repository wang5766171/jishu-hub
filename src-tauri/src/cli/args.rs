use clap::{Parser, Subcommand};

/// Jishu Hub — multi-agent orchestrator CLI.
#[derive(Parser, Debug)]
#[command(name = "jishu", version, about = "Jishu Hub multi-agent orchestrator")]
pub struct Cli {
    /// Output results as JSON-lines.
    #[arg(long, global = true)]
    pub json: bool,

    /// Set log level (trace, debug, info, warn, error).
    #[arg(long, global = true, value_name = "LEVEL")]
    pub log: Option<String>,

    /// Override the Jishu home directory.
    #[arg(long, global = true, env = "JISHU_HOME")]
    pub home: Option<String>,

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

    /// Manage projects.
    Projects {
        #[command(subcommand)]
        action: ProjectAction,
    },

    /// Manage sessions.
    Sessions {
        #[command(subcommand)]
        action: SessionAction,
    },

    /// Chat with an agent.
    Chat {
        #[command(subcommand)]
        action: ChatAction,
    },

    /// View or edit configuration.
    Config {
        #[command(subcommand)]
        action: ConfigAction,
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

    /// Manage model configurations.
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

    /// Bridge to external agent processes.
    #[command(name = "agent-bridge")]
    AgentBridge {
        #[command(subcommand)]
        action: AgentBridgeAction,
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

// ── Projects ─────────────────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum ProjectAction {
    /// List known projects.
    List,

    /// Add a project by path.
    Add {
        /// Path to the project directory.
        path: String,
    },

    /// Remove a project.
    Remove {
        /// Encoded project name or path.
        project: String,
    },

    /// Show project details.
    Info {
        /// Project path or encoded name.
        project: String,
    },
}

// ── Sessions ─────────────────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum SessionAction {
    /// List sessions for a project.
    List {
        /// Project path or encoded name.
        #[arg(long, default_value = ".")]
        project: String,
    },

    /// Show session messages.
    Show {
        /// Session ID.
        session_id: String,

        /// Project path or encoded name.
        #[arg(long, default_value = ".")]
        project: String,
    },

    /// Delete a session.
    Delete {
        /// Session ID.
        session_id: String,
    },
}

// ── Chat ─────────────────────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum ChatAction {
    /// Send a message to an agent.
    Send {
        /// Agent identifier.
        #[arg(long, default_value = "claude-code")]
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

// ── Config ───────────────────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum ConfigAction {
    /// Show current configuration.
    Show,

    /// Set a configuration key.
    Set {
        /// Key name.
        key: String,

        /// Value.
        value: String,
    },

    /// Get a configuration value.
    Get {
        /// Key name.
        key: String,
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

    /// Add a model configuration.
    Add {
        /// Model identifier (e.g. "gpt-4o", "claude-sonnet-4").
        #[arg(long)]
        id: String,

        /// Provider name.
        #[arg(long)]
        provider: String,

        /// API base URL.
        #[arg(long)]
        base_url: Option<String>,

        /// API key (or set via environment variable).
        #[arg(long)]
        api_key: Option<String>,
    },

    /// Remove a model configuration.
    Remove {
        /// Model identifier.
        id: String,
    },

    /// Test a model connection.
    Test {
        /// Model identifier.
        id: String,
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

// ── AgentBridge ──────────────────────────────────────────────────────────────

#[derive(Subcommand, Debug)]
pub enum AgentBridgeAction {
    /// Start a bridge to an external agent.
    Start {
        /// Agent identifier.
        agent: String,

        /// Bridge transport (stdio, tcp).
        #[arg(long, default_value = "stdio")]
        transport: String,
    },

    /// List active bridges.
    List,

    /// Stop a bridge.
    Stop {
        /// Bridge ID.
        bridge_id: String,
    },
}
