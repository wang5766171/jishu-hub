pub mod args;
pub mod commands;
pub mod error;
pub mod jsonl;
pub mod output;
pub mod resolver;
pub mod runtime;
pub mod truncate;

pub fn main() {
    use clap::Parser;
    let args = args::Cli::parse();
    runtime::run(args);
}
