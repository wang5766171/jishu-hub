pub mod server;
pub mod session;
pub mod translate;

/// Entry point for the ACP server (stdio JSON-RPC).
///
/// `log_file` is accepted for CLI compatibility but currently ignored;
/// stdout must stay clean for JSON-RPC framing.
pub fn run(cwd: Option<String>, model: Option<String>, _log_file: Option<String>) -> Result<(), String> {
    server::run_stdio(cwd, model)
}
