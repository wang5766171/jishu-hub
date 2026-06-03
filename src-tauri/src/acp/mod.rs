//! ACP (Agent Communication Protocol) — stdio JSON-RPC 2.0 server.
//!
//! This is the **external** protocol layer for editor integrations (Zed,
//! JetBrains, VS Code extensions). Invoked via `jishu acp start`.
//!
//! Distinct from `acp_runtime.rs` which is the Tauri-internal mpsc-based
//! runtime for spawning agents within the desktop app.

pub mod server;
pub mod session;
pub mod translate;

/// Entry point for the ACP server (stdio JSON-RPC).
///
/// `log_file` is accepted for CLI compatibility but currently ignored;
/// stdout must stay clean for JSON-RPC framing.
pub fn run(
    cwd: Option<String>,
    model: Option<String>,
    _log_file: Option<String>,
) -> Result<(), String> {
    server::run_stdio(cwd, model)
}
