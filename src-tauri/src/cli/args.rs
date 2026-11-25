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

    /// Manage plugins (add/list/remove/enable/disable).
    Plugins {
        #[command(subcommand)]
        action: PluginAction,
    },

    /// Extension registry: list entries and record GUI-adaptation verdicts.
    Extensions {
        #[command(subcommand)]
        action: ExtensionAction,
    },

    /// Task artifacts for tool plugins (lock-requirement/commit-plan).
    #[command(name = "task-artifact")]
    TaskArtifact {
        #[command(subcommand)]
        action: TaskArtifactAction,
    },

    /// Project memory shared across agents (key-value store).
    Memory {
        #[command(subcommand)]
        action: MemoryAction,
    },

    /// Hub MCP aggregation server and agent config injection
    /// (serve/inject/remove/status).
    Mcp {
        #[command(subcommand)]
        action: McpAction,
    },

    /// Skill distribution to agent skill dirs (deploy/remove/status).
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

// ── Plugins & extensions（v0.8.1 需求4 / v0.9.8 需求4 D4-8/D4-7）──────────────
// 帮助文案（`///` 文档注释）是给用户看的：只写功能是什么，统一英文；出处与
// 内部编号留在普通 `//` 注释里。

#[derive(Subcommand, Debug)]
pub enum ExtensionAction {
    /// List the extension registry (builtin flag, state, adapters, verdicts).
    List,

    /// Record the GUI-adaptation verdict for an extension ("noneeded" = a
    /// low-level tool that needs no UI; "pending" = reset to undecided).
    Verdict {
        /// Version-independent package key (e.g. npm:pi-smart-fetch).
        pkg_key: String,
        /// "pending" or "noneeded".
        verdict: String,
        /// One-line reason (optional).
        #[arg(long = "note")]
        note: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum PluginAction {
    // agent 创建插件前可经此查全部开放能力，与 jishu-plugin-authoring 技能的
    // API.md 单源同文（二十三轮，用户裁决的说明机制）。
    /// Print the plugin API reference (open capabilities for component code).
    Api,

    /// Install a plugin from a local TOML manifest file (validated on install).
    Add {
        /// Path to the plugin manifest TOML.
        path: String,
    },

    /// Install a hybrid plugin from a local directory (plugin.toml +
    /// component.js; installed disabled, GUI confirmation card enables it).
    #[command(name = "add-hybrid")]
    AddHybrid {
        /// Path to the plugin directory (holding plugin.toml + component.js).
        path: String,
    },

    /// Print the full manifest (TOML) of an installed plugin.
    Get {
        /// Plugin identifier.
        id: String,
    },

    /// Overwrite-update an installed plugin from a TOML file (id must match).
    Update {
        /// Plugin identifier (must equal the manifest's info.id).
        id: String,

        /// Path to the new plugin manifest TOML.
        path: String,
    },

    /// Edit an installed plugin in place: targeted field assignment
    /// (--field section.key=value) or open the manifest location in the
    /// file manager (--open; apply changes afterwards via update).
    Edit {
        /// Plugin identifier.
        id: String,

        /// Targeted assignment, repeatable: `--field section.key=value`
        /// (dotted path, last segment is the key; value parsed as TOML,
        /// falling back to string). Array items not addressable.
        #[arg(long = "field")]
        field: Vec<String>,

        /// Reveal the manifest in the system file manager (no write).
        #[arg(long = "open", default_value_t = false)]
        open: bool,
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

    /// Validate a plugin directory (or a single manifest TOML) without
    /// installing: basic structural checks locally + full validation via the
    /// running hub's TS validators (same implementation as the GUI wizard;
    /// falls back to basic-only with a warning when the hub is not running).
    Validate {
        /// Path to the plugin directory (holding plugin.toml [+ component.js])
        /// or a single plugin.toml file.
        path: String,
    },

    /// Import a pi extension (.ts) into the agent extensions dir (disabled
    /// by default; enable via the hub GUI card or pi_extension_enable).
    #[command(name = "import-extension")]
    ImportExtension {
        /// Path to the extension .ts file.
        path: String,
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

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /// 形如 `v0.8.1` 的版本标记。
    fn has_version_tag(text: &str) -> bool {
        let chars: Vec<char> = text.chars().collect();
        chars.windows(2).enumerate().any(|(i, w)| {
            w[0] == 'v' && w[1].is_ascii_digit() && {
                let mut dots = 0;
                for c in chars[i + 1..].iter().take(12) {
                    if *c == '.' {
                        dots += 1;
                    } else if !c.is_ascii_digit() {
                        break;
                    }
                }
                dots >= 2
            }
        })
    }

    fn is_internal_note(text: &str) -> bool {
        text.contains("需求")
            || has_version_tag(text)
            || text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
    }

    /// 帮助文案是给用户看的：不得夹带内部开发备注（需求编号、版本号），
    /// 也不得中英夹杂——命令行帮助统一用英文。遍历全部子命令与参数的
    /// about / help，防止再把 `///` 注释里的内部说明带进 `--help`。
    #[test]
    fn help_text_carries_no_internal_notes() {
        fn collect(cmd: &clap::Command, path: &mut Vec<String>, bad: &mut Vec<String>) {
            let where_ = if path.is_empty() {
                "(root)".to_string()
            } else {
                path.join(" ")
            };
            for text in [cmd.get_about(), cmd.get_long_about()]
                .into_iter()
                .flatten()
                .map(|t| t.to_string())
            {
                if is_internal_note(&text) {
                    bad.push(format!("{where_} — about: {text}"));
                }
            }
            for arg in cmd.get_arguments() {
                for (kind, text) in [("help", arg.get_help()), ("long_help", arg.get_long_help())] {
                    if let Some(t) = text {
                        let t = t.to_string();
                        if is_internal_note(&t) {
                            bad.push(format!("{where_} --{} {kind}: {t}", arg.get_id()));
                        }
                    }
                }
            }
            for sub in cmd.get_subcommands() {
                path.push(sub.get_name().to_string());
                collect(sub, path, bad);
                path.pop();
            }
        }

        let mut bad = Vec::new();
        collect(&Cli::command(), &mut Vec::new(), &mut bad);
        assert!(
            bad.is_empty(),
            "帮助文案里有内部备注或中文：\n{}",
            bad.join("\n")
        );
    }
}
