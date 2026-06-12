use crate::orchestrator::domain::graph::{EvaluatorSpec, LoopControllerConfig};
use crate::orchestrator::events::payloads::EvaluatorResult;

pub fn evaluate(
    config: &LoopControllerConfig,
    iteration: u32,
    now: i64,
    body_succeeded: bool,
    node_evaluator_output: Option<&serde_json::Value>,
) -> Result<EvaluatorResult, String> {
    let mut result = match &config.evaluator {
        EvaluatorSpec::Inline { rules } => evaluate_rules(rules, iteration, now, body_succeeded)?,
        EvaluatorSpec::NodeRef { .. } => {
            let output = node_evaluator_output
                .ok_or_else(|| "node evaluator did not produce structured output".to_string())?;
            evaluate_rules(output, iteration, now, body_succeeded)?
        }
    };

    if !matches!(
        result,
        EvaluatorResult::Complete { .. } | EvaluatorResult::Fail { .. }
    ) {
        if let Some(max_iterations) = config.max_iterations {
            if iteration.saturating_add(1) >= max_iterations {
                result = EvaluatorResult::Fail {
                    error: format!("loop reached max_iterations={max_iterations}"),
                };
            }
        }
    }
    Ok(result)
}

fn evaluate_rules(
    rules: &serde_json::Value,
    iteration: u32,
    now: i64,
    body_succeeded: bool,
) -> Result<EvaluatorResult, String> {
    if let Some(complete_when) = rules.get("complete_when") {
        let iteration_reached = complete_when
            .get("iteration_gte")
            .and_then(|value| value.as_u64())
            .map(|value| iteration as u64 >= value)
            .unwrap_or(false);
        let success_reached = complete_when
            .get("all_succeeded")
            .and_then(|value| value.as_bool())
            .map(|required| !required || body_succeeded)
            .unwrap_or(false);
        if iteration_reached || success_reached {
            return Ok(EvaluatorResult::Complete {
                result: rules
                    .get("result")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({"iteration": iteration})),
            });
        }
        return Ok(EvaluatorResult::Continue);
    }

    let outcome = rules
        .get("outcome")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "loop evaluator must return outcome or complete_when".to_string())?;
    match outcome {
        "continue" => Ok(EvaluatorResult::Continue),
        "wait" => {
            let wake_at = rules
                .get("wake_at")
                .and_then(|value| value.as_i64())
                .or_else(|| {
                    rules
                        .get("wait_ms")
                        .and_then(|value| value.as_u64())
                        .map(|wait_ms| now.saturating_add(wait_ms as i64))
                })
                .ok_or_else(|| "wait outcome requires wake_at or wait_ms".to_string())?;
            Ok(EvaluatorResult::Wait { wake_at })
        }
        "complete" => Ok(EvaluatorResult::Complete {
            result: rules.get("result").cloned().unwrap_or_default(),
        }),
        "pause" => Ok(EvaluatorResult::Pause {
            reason: rules
                .get("reason")
                .and_then(|value| value.as_str())
                .unwrap_or("loop requested human decision")
                .to_string(),
        }),
        "fail" => Ok(EvaluatorResult::Fail {
            error: rules
                .get("error")
                .and_then(|value| value.as_str())
                .unwrap_or("loop evaluator failed")
                .to_string(),
        }),
        other => Err(format!("unsupported loop evaluator outcome {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(rules: serde_json::Value) -> LoopControllerConfig {
        LoopControllerConfig {
            body_node_ids: vec!["body".into()],
            evaluator: EvaluatorSpec::Inline { rules },
            interval_ms: 100,
            backoff_multiplier: None,
            max_interval_ms: None,
            termination_condition: "test".into(),
            max_iterations: Some(3),
            deadline_ms: None,
            token_budget: None,
            cost_budget_usd: None,
            no_progress_threshold: None,
            escalation_policy: "pause".into(),
        }
    }

    #[test]
    fn inline_evaluator_completes_when_body_succeeds() {
        let result = evaluate(
            &config(serde_json::json!({
                "complete_when": {"all_succeeded": true},
                "result": {"ok": true}
            })),
            0,
            10,
            true,
            None,
        )
        .unwrap();
        assert!(matches!(result, EvaluatorResult::Complete { .. }));
    }

    #[test]
    fn wait_is_converted_to_persistable_wake_time() {
        let result = evaluate(
            &config(serde_json::json!({"outcome": "wait", "wait_ms": 250})),
            0,
            1_000,
            true,
            None,
        )
        .unwrap();
        assert!(matches!(result, EvaluatorResult::Wait { wake_at: 1_250 }));
    }

    #[test]
    fn hard_iteration_budget_overrides_continue() {
        let result = evaluate(
            &config(serde_json::json!({"outcome": "continue"})),
            2,
            1_000,
            true,
            None,
        )
        .unwrap();
        assert!(matches!(result, EvaluatorResult::Fail { .. }));
    }
}
