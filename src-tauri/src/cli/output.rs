/// Execution context passed to every command handler.
pub struct ExecutionContext {
    /// When true, emit JSON-lines output instead of human-readable tables.
    pub json: bool,
    /// True when stdout is connected to a terminal.
    pub tty: bool,
}

impl ExecutionContext {
    pub fn new(json: bool) -> Self {
        Self {
            json,
            tty: atty::is(atty::Stream::Stdout),
        }
    }
}
