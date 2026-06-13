use crate::orchestrator::domain::graph::{EvaluatorSpec, LoopControllerConfig};
use crate::orchestrator::domain::run::AttemptUsage;
use crate::orchestrator::events::payloads::EvaluatorResult;

/// A loop must declare at least one hard budget so it cannot run unbounded.
///
/// `no_progress_threshold` counts as a hard budget because `evaluate` enforces
/// it as a terminal constraint (pause/fail). Omitting it here would make a loop
/// that declares only `no_progress_threshold` be rejected as budgetless by
/// `start_loop_iteration`, contradicting `evaluate`.
pub fn has_hard_budget(config: &LoopControllerConfig) -> bool {
    config.max_iterations.is_some()
        || config.deadline_ms.is_some()
        || config.token_budget.is_some()
        || config.cost_budget_usd.is_some()
        || config.no_progress_threshold.is_some()
}

pub fn evaluate(
    config: &LoopControllerConfig,
    iteration: u32,
    now: i64,
    started_at: i64,
    body_succeeded: bool,
    node_evaluator_output: Option<&serde_json::Value>,
    accumulated_usage: &AttemptUsage,
    iterations_without_progress: u32,
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
        // Wall-clock deadline (M6/P03: consolidated into `evaluate` so the hard
        // budgets have a single arbiter and nested loops can't miss it; was
        // previously enforced only as a `drive_loops` post-override).
        if let Some(deadline_ms) = config.deadline_ms {
            let elapsed = now.saturating_sub(started_at);
            if elapsed >= deadline_ms as i64 {
                result = EvaluatorResult::Fail {
                    error: format!("loop deadline_ms={deadline_ms} exceeded (elapsed {elapsed}ms)"),
                };
            }
        }
        // Token budget (input + output tokens)
        if let Some(budget) = config.token_budget {
            let used = accumulated_usage
                .input_tokens
                .saturating_add(accumulated_usage.output_tokens);
            if used >= budget {
                result = EvaluatorResult::Fail {
                    error: format!("loop token_budget={budget} exhausted (used {used})"),
                };
            }
        }
        // Cost budget
        if !matches!(result, EvaluatorResult::Fail { .. }) {
            if let Some(budget) = config.cost_budget_usd {
                if accumulated_usage.cost_usd >= budget {
                    result = EvaluatorResult::Fail {
                        error: format!(
                            "loop cost_budget_usd={budget} exhausted (used {})",
                            accumulated_usage.cost_usd
                        ),
                    };
                }
            }
        }
        // No-progress escalation (only if still non-terminal)
        if !matches!(
            result,
            EvaluatorResult::Complete { .. } | EvaluatorResult::Fail { .. }
        ) {
            if let Some(threshold) = config.no_progress_threshold {
                if iterations_without_progress >= threshold {
                    result = match config.escalation_policy.as_str() {
                        "pause" => EvaluatorResult::Pause {
                            reason: format!(
                                "loop exceeded no_progress_threshold={threshold} without progress"
                            ),
                        },
                        _ => EvaluatorResult::Fail {
                            error: format!(
                                "loop exceeded no_progress_threshold={threshold} without progress"
                            ),
                        },
                    };
                }
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
            10,
            true,
            None,
            &AttemptUsage::default(),
            0,
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
            1_000,
            true,
            None,
            &AttemptUsage::default(),
            0,
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
            1_000,
            true,
            None,
            &AttemptUsage::default(),
            0,
        )
        .unwrap();
        assert!(matches!(result, EvaluatorResult::Fail { .. }));
    }

    #[test]
    fn deadline_budget_overrides_continue() {
        let cfg = {
            let mut c = config(serde_json::json!({"outcome": "continue"}));
            c.max_iterations = None;
            c.deadline_ms = Some(5000);
            c
        };
        // started_at=1000, now=7000 → elapsed 6000 >= deadline 5000 → Fail.
        let result = evaluate(
            &cfg,
            0,
            7_000,
            1_000,
            true,
            None,
            &AttemptUsage::default(),
            0,
        )
        .unwrap();
        assert!(matches!(result, EvaluatorResult::Fail { .. }));
        if let EvaluatorResult::Fail { error } = result {
            assert!(error.contains("deadline_ms=5000"));
        }
    }

    #[test]
    fn deadline_not_triggered_within_window() {
        let cfg = {
            let mut c = config(serde_json::json!({"outcome": "continue"}));
            c.max_iterations = None;
            c.deadline_ms = Some(5000);
            c
        };
        // elapsed 2000 < deadline 5000 → continue (not fail).
        let result = evaluate(
            &cfg,
            0,
            3_000,
            1_000,
            true,
            None,
            &AttemptUsage::default(),
            0,
        )
        .unwrap();
        assert!(matches!(result, EvaluatorResult::Continue));
    }

    #[test]
    fn token_budget_exhausted_overrides_continue() {
        let cfg = {
            let mut c = config(serde_json::json!({"outcome": "continue"}));
            c.token_budget = Some(100);
            c
        };
        let accumulated = AttemptUsage {
            input_tokens: 60,
            output_tokens: 40,
            cost_usd: 0.0,
        };
        let result = evaluate(&cfg, 0, 1_000, 1_000, true, None, &accumulated, 0).unwrap();
        assert!(matches!(result, EvaluatorResult::Fail { .. }));
        if let EvaluatorResult::Fail { error } = result {
            assert!(error.contains("token_budget=100") && error.contains("used 100"));
        }
    }

    #[test]
    fn cost_budget_exhausted_overrides_continue() {
        let cfg = {
            let mut c = config(serde_json::json!({"outcome": "continue"}));
            c.cost_budget_usd = Some(0.5);
            c
        };
        let accumulated = AttemptUsage {
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0.5,
        };
        let result = evaluate(&cfg, 0, 1_000, 1_000, true, None, &accumulated, 0).unwrap();
        assert!(matches!(result, EvaluatorResult::Fail { .. }));
        if let EvaluatorResult::Fail { error } = result {
            assert!(error.contains("cost_budget_usd=0.5"));
        }
    }

    #[test]
    fn no_progress_threshold_escalates_to_pause() {
        let cfg = {
            let mut c = config(serde_json::json!({"outcome": "continue"}));
            c.no_progress_threshold = Some(2);
            c.escalation_policy = "pause".into();
            c
        };
        // Use iteration 0 to avoid triggering max_iterations (which is Some(3) from config())
        let result = evaluate(
            &cfg,
            0,
            1_000,
            1_000,
            true,
            None,
            &AttemptUsage::default(),
            2,
        )
        .unwrap();
        assert!(matches!(result, EvaluatorResult::Pause { .. }));
        if let EvaluatorResult::Pause { reason } = result {
            assert!(reason.contains("no_progress_threshold=2"));
        }
    }

    #[test]
    fn no_progress_threshold_fails_when_policy_not_pause() {
        let cfg = {
            let mut c = config(serde_json::json!({"outcome": "continue"}));
            c.no_progress_threshold = Some(2);
            c.escalation_policy = "fail".into();
            c
        };
        // Use iteration 0 to avoid triggering max_iterations
        let result = evaluate(
            &cfg,
            0,
            1_000,
            1_000,
            true,
            None,
            &AttemptUsage::default(),
            2,
        )
        .unwrap();
        assert!(matches!(result, EvaluatorResult::Fail { .. }));
    }

    #[test]
    fn has_hard_budget_detects_budgetless_loop() {
        let cfg = config(serde_json::json!({"outcome": "continue"}));
        // All four budgets Some
        let cfg_with_all = LoopControllerConfig {
            max_iterations: Some(10),
            deadline_ms: Some(5000),
            token_budget: Some(1000),
            cost_budget_usd: Some(1.0),
            ..cfg.clone()
        };
        assert!(has_hard_budget(&cfg_with_all));

        // Each one individually
        let cfg_max = LoopControllerConfig {
            max_iterations: Some(10),
            ..cfg.clone()
        };
        assert!(has_hard_budget(&cfg_max));

        let cfg_deadline = LoopControllerConfig {
            deadline_ms: Some(5000),
            ..cfg.clone()
        };
        assert!(has_hard_budget(&cfg_deadline));

        let cfg_token = LoopControllerConfig {
            token_budget: Some(1000),
            ..cfg.clone()
        };
        assert!(has_hard_budget(&cfg_token));

        let cfg_cost = LoopControllerConfig {
            cost_budget_usd: Some(1.0),
            ..cfg.clone()
        };
        assert!(has_hard_budget(&cfg_cost));

        // None - default config() has max_iterations set, so clear it
        let cfg_none = LoopControllerConfig {
            max_iterations: None,
            deadline_ms: None,
            token_budget: None,
            cost_budget_usd: None,
            ..cfg
        };
        assert!(!has_hard_budget(&cfg_none));
    }

    #[test]
    fn has_hard_budget_counts_no_progress_threshold() {
        // Regression: a loop that declares ONLY a no_progress_threshold must be
        // treated as having a hard budget. `evaluate` enforces no_progress as a
        // hard constraint, so `has_hard_budget` must agree — otherwise
        // `start_loop_iteration` rejects the loop as budgetless while `evaluate`
        // would have bounded it.
        let base = config(serde_json::json!({"outcome": "continue"}));
        let cfg = LoopControllerConfig {
            max_iterations: None,
            deadline_ms: None,
            token_budget: None,
            cost_budget_usd: None,
            no_progress_threshold: Some(3),
            ..base
        };
        assert!(has_hard_budget(&cfg));
    }
}
