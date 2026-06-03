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

            let events =
                collect_events_in_root(&runs_dir, r#type.as_deref(), agent.as_deref(), limit)
                    .map_err(CliError::Io)?;

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

fn collect_events_in_root(
    runs_dir: &std::path::Path,
    event_type: Option<&str>,
    agent: Option<&str>,
    limit: usize,
) -> Result<Vec<serde_json::Value>, std::io::Error> {
    let mut events = Vec::new();
    for entry in std::fs::read_dir(runs_dir)?.take(limit) {
        let entry = entry?;
        let trace_path = entry.path().join("trace.jsonl");
        if !trace_path.exists() {
            continue;
        }
        let content = std::fs::read_to_string(&trace_path)?;
        for line in content
            .lines()
            .rev()
            .take(limit)
            .filter(|line| !line.is_empty())
        {
            if let Ok(ev) = serde_json::from_str::<serde_json::Value>(line) {
                if !event_type_matches(&ev, event_type) {
                    continue;
                }
                if !agent_matches(&ev, agent) {
                    continue;
                }
                events.push(ev);
            }
        }
    }
    events.truncate(limit);
    events.reverse();
    Ok(events)
}

fn event_type_matches(ev: &serde_json::Value, event_type: Option<&str>) -> bool {
    event_type
        .map(|expected| ev.get("kind").and_then(|value| value.as_str()) == Some(expected))
        .unwrap_or(true)
}

fn agent_matches(ev: &serde_json::Value, agent: Option<&str>) -> bool {
    let Some(expected) = agent else {
        return true;
    };

    ev.get("agent").and_then(|value| value.as_str()) == Some(expected)
        || ev.get("target_agent").and_then(|value| value.as_str()) == Some(expected)
        || ev
            .get("sub_event")
            .map(|sub_event| agent_matches(sub_event, Some(expected)))
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_query_filters_by_kind_and_target_agent() {
        let root = std::env::temp_dir().join(format!("jishu_event_test_{}", std::process::id()));
        let run_dir = root.join("r_1");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&run_dir).unwrap();
        std::fs::write(
            run_dir.join("trace.jsonl"),
            [
                r#"{"kind":"task_step","step_kind":"plan","run_id":"r_1"}"#,
                r#"{"kind":"sub_agent_dispatch","target_agent":"claude2","run_id":"r_1"}"#,
                r#"{"kind":"raw","agent":"codex","run_id":"r_1"}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let task_steps = collect_events_in_root(&root, Some("task_step"), None, 10).unwrap();
        assert_eq!(task_steps.len(), 1);
        assert_eq!(task_steps[0]["step_kind"], "plan");

        let claude_events = collect_events_in_root(&root, None, Some("claude2"), 10).unwrap();
        assert_eq!(claude_events.len(), 1);
        assert_eq!(claude_events[0]["kind"], "sub_agent_dispatch");

        let _ = std::fs::remove_dir_all(&root);
    }
}
