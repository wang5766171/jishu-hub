//! Structured evaluation result emitted by a `Reflect` node (design §3.1, §9.3).
//!
//! A `Reflect` node runs the Jishu Supervisor over accumulated run facts and
//! must return a structured `EvaluationResult` (not free text). The orchestrator
//! parses it to drive recovery: `Pass` completes the goal, `Rework`/`Stop`/
//! `Human` feed the recovery dispatcher (`recovery::decide_recovery`).

use serde::{Deserialize, Serialize};

/// Supervisor verdict over accumulated run facts (design §9.3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationVerdict {
    /// Goal/acceptance criteria are satisfied.
    Pass,
    /// Progress made but the node must be reworked (bounded repair).
    Rework,
    /// Stop the run — the goal cannot be satisfied as planned.
    Stop,
    /// Escalate to a human decision.
    Human,
}

/// Structured output a `Reflect` node must produce.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EvaluationResult {
    pub verdict: EvaluationVerdict,
    pub rationale: String,
    #[serde(default)]
    pub evidence: Vec<String>,
    /// Whether the node's declared acceptance criteria were met.
    pub acceptance_passed: bool,
}

/// Failure to parse a `Reflect` node's output into an `EvaluationResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvaluationParseError {
    NotJson(String),
    InvalidSchema(String),
}

impl std::fmt::Display for EvaluationParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotJson(message) => write!(f, "evaluation output is not valid JSON: {message}"),
            Self::InvalidSchema(message) => write!(f, "evaluation output failed schema: {message}"),
        }
    }
}

impl std::error::Error for EvaluationParseError {}

/// Parse a `Reflect` node's textual output into a structured `EvaluationResult`.
/// The output must be a JSON object matching the schema; free-form text, missing
/// fields, or unknown verdicts are rejected (the supervisor must emit structured
/// output, never free text that the orchestrator guesses at).
pub fn parse_evaluation_result(output: &str) -> Result<EvaluationResult, EvaluationParseError> {
    let value: serde_json::Value = serde_json::from_str(output.trim())
        .map_err(|error| EvaluationParseError::NotJson(error.to_string()))?;
    if !value.is_object() {
        return Err(EvaluationParseError::InvalidSchema(
            "expected a JSON object".into(),
        ));
    }
    serde_json::from_value::<EvaluationResult>(value)
        .map_err(|error| EvaluationParseError::InvalidSchema(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_pass_evaluation() {
        let output = r#"{"verdict":"pass","rationale":"所有验收通过","evidence":["测试全绿","接口已实现"],"acceptance_passed":true}"#;
        let result = parse_evaluation_result(output).unwrap();
        assert_eq!(result.verdict, EvaluationVerdict::Pass);
        assert_eq!(result.rationale, "所有验收通过");
        assert_eq!(
            result.evidence,
            vec!["测试全绿".to_string(), "接口已实现".to_string()]
        );
        assert!(result.acceptance_passed);
    }

    #[test]
    fn parses_rework_without_evidence() {
        let output =
            r#"{"verdict":"rework","rationale":"需要补充权限脱敏","acceptance_passed":false}"#;
        let result = parse_evaluation_result(output).unwrap();
        assert_eq!(result.verdict, EvaluationVerdict::Rework);
        assert!(result.evidence.is_empty());
        assert!(!result.acceptance_passed);
    }

    #[test]
    fn rejects_unknown_verdict() {
        let output = r#"{"verdict":"maybe","rationale":"x","acceptance_passed":true}"#;
        assert!(parse_evaluation_result(output).is_err());
    }

    #[test]
    fn rejects_missing_verdict() {
        let output = r#"{"rationale":"x","acceptance_passed":true}"#;
        assert!(parse_evaluation_result(output).is_err());
    }

    #[test]
    fn rejects_non_json_output() {
        assert!(parse_evaluation_result("the task looks done").is_err());
    }
}
