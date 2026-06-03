use super::{PlanContext, PlanError, Planner};
use crate::orchestrator::spec::{Step, StepKind, TaskSpec};

pub struct RoutingPlanner;

impl Planner for RoutingPlanner {
    fn id(&self) -> &str {
        "routing"
    }

    fn plan(&self, spec: &TaskSpec, _ctx: &PlanContext) -> Result<Vec<Step>, PlanError> {
        let message = &spec.message;
        let project = spec.project_path.clone().unwrap_or_else(|| ".".to_string());

        // Parse @agent prefixes from message
        let parts = parse_agent_prefixes(message);
        if parts.is_empty() {
            // No @agent prefix found, fall back to single dispatch
            return Ok(vec![Step {
                step_id: "sp_0".to_string(),
                kind: StepKind::Dispatch {
                    agent: spec
                        .agent_hint
                        .as_deref()
                        .unwrap_or("claude-code")
                        .to_string(),
                    message: message.clone(),
                    project,
                    session: None,
                },
                depends_on: vec![],
                timeout_ms: spec.deadline_ms,
            }]);
        }

        let steps: Vec<Step> = parts
            .into_iter()
            .enumerate()
            .map(|(i, (agent, msg))| Step {
                step_id: format!("sp_{i}"),
                kind: StepKind::Dispatch {
                    agent,
                    message: msg,
                    project: project.clone(),
                    session: None,
                },
                depends_on: if i > 0 {
                    vec![format!("sp_{}", i - 1)]
                } else {
                    vec![]
                },
                timeout_ms: spec.deadline_ms,
            })
            .collect();

        Ok(steps)
    }
}

/// Parse @agent prefixes from a message string.
/// Returns pairs of (agent_id, remainder_message).
fn parse_agent_prefixes(message: &str) -> Vec<(String, String)> {
    let agent_map = [
        ("@claude", "claude-code"),
        ("@codex", "codex"),
        ("@opencode", "opencode"),
        ("@jishu", "jishu-self"),
    ];

    let mut parts = Vec::new();
    let text = message.to_string();
    let mut chars = text.chars().peekable();
    let mut buf = String::new();
    let mut current_agent: Option<&str> = None;

    while let Some(ch) = chars.next() {
        if ch == '@' {
            let rest: String = chars.clone().collect();
            let matched = agent_map
                .iter()
                .find(|(prefix, _)| rest.starts_with(&prefix[1..]));
            if let Some((prefix, agent_id)) = matched {
                // Flush current buffer as message for previous agent
                let msg = buf.trim().to_string();
                if !msg.is_empty() || current_agent.is_some() {
                    if let Some(a) = current_agent {
                        parts.push((a.to_string(), msg));
                    }
                }
                current_agent = Some(*agent_id);
                buf.clear();
                // Skip the prefix characters
                for _ in prefix.chars().skip(1) {
                    chars.next();
                }
                continue;
            }
        }
        buf.push(ch);
    }

    // Flush last
    let msg = buf.trim().to_string();
    if let Some(a) = current_agent {
        parts.push((a.to_string(), msg));
    }

    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_single_agent() {
        let parts = parse_agent_prefixes("@codex run tests");
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].0, "codex");
        assert_eq!(parts[0].1, "run tests");
    }

    #[test]
    fn parse_multiple_agents() {
        let parts = parse_agent_prefixes("@codex run tests  @claude review output");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].0, "codex");
        assert_eq!(parts[1].0, "claude-code");
    }

    #[test]
    fn parse_no_prefix() {
        let parts = parse_agent_prefixes("hello world");
        assert!(parts.is_empty());
    }
}
