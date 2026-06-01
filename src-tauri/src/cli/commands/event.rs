use crate::cli::args::EventAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: EventAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        EventAction::Query {
            r#type,
            agent,
            limit,
        } => {
            let home =
                dirs::home_dir().ok_or_else(|| CliError::Internal("No home dir".to_string()))?;
            let runs_dir = home.join(".jishu-hub").join("runs");
            if !runs_dir.exists() {
                if ctx.json {
                    println!("[]");
                } else {
                    println!("No events found.");
                }
                return Ok(());
            }

            let mut events = Vec::new();
            for entry in std::fs::read_dir(&runs_dir)
                .map_err(CliError::Io)?
                .take(limit)
            {
                let entry = entry.map_err(CliError::Io)?;
                let trace_path = entry.path().join("trace.jsonl");
                if !trace_path.exists() {
                    continue;
                }
                let content = std::fs::read_to_string(&trace_path).map_err(CliError::Io)?;
                for line in content
                    .lines()
                    .rev()
                    .take(limit)
                    .filter(|l| !l.is_empty())
                {
                    if let Ok(ev) = serde_json::from_str::<serde_json::Value>(line) {
                        events.push(ev);
                    }
                }
            }
            events.truncate(limit);
            events.reverse();

            if ctx.json {
                println!(
                    "{}",
                    serde_json::to_string(&events).map_err(CliError::Serde)?
                );
            } else {
                for ev in &events {
                    println!("{}", serde_json::to_string(ev).unwrap_or_default());
                }
            }
            let _ = (r#type, agent);
            Ok(())
        }
        EventAction::Tail { r#type } => {
            // Tail is a stub -- would watch trace.jsonl for new lines
            println!("Event tail is not yet implemented.");
            let _ = r#type;
            Ok(())
        }
    }
}
