use super::*;

/// Parsed view of a renderable ACP `elicitation/create` (claude-agent-acp
/// `AskUserQuestion`, form mode). `None` when the request cannot be surfaced as
/// a single-choice interaction (url mode, arbitrary MCP schema, no enum) — the
/// caller replies `cancel` to avoid stalling the turn.
#[derive(Debug, Clone)]
pub(super) struct AcpQuestion {
    pub(super) field_name: String,
    pub(super) prompt: String,
    pub(super) options: Vec<InteractionOption>,
    pub(super) is_multi_select: bool,
}

pub(super) struct AcpElicitation {
    pub(super) questions: Vec<AcpQuestion>,
}

/// Parse a form-mode `elicitation/create` into a single-choice interaction.
///
/// claude-agent-acp (`elicitation.ts`) renders each `AskUserQuestion` question
/// as `requestedSchema.properties.question_<n>` — single-select `{type:"string",
/// oneOf:[{const:LABEL,title:"LABEL — desc"}]}` (or multi-select `items.anyOf`)
/// — followed by a `question_<n>_custom` free-text field. The enum `const` is
/// always the option **label** (what the tool records as the answer), so the
/// emitted `InteractionOption` sets `option_id == label == const`: the frontend
/// submits the label (`formatInteractionResponseValue` maps optionId→label) and
/// we write it back as `content[content_field]`, which the tool matches against
/// the enum const. Multi-question/multi-select elicitations are reduced to the
/// first question, single-select (the A/B/C decision v0.6.0 targets); the
/// single-value write-back is consistent with the PiRpc/codex runtimes.
pub(super) fn parse_acp_elicitation(
    params: &serde_json::Value,
    last_prompts: &Option<Vec<String>>,
) -> Option<AcpElicitation> {
    let mode = params
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("form");
    if mode != "form" {
        return None; // url-mode elicitations have no form rendering
    }
    let properties = params
        .get("requestedSchema")
        .and_then(|s| s.get("properties"))
        .and_then(|p| p.as_object())?;

    // Collect ALL `question_<n>` fields sorted by index (skip `_custom`
    // companion fields). This handles both single-question and multi-question
    // AskUserQuestion calls.
    let mut question_fields: Vec<(&String, &serde_json::Value)> = properties
        .iter()
        .filter(|(k, _)| is_question_field(k))
        .collect();
    question_fields.sort_by_key(|(k, _)| {
        k.strip_prefix("question_")
            .and_then(|n| n.parse::<u32>().ok())
            .unwrap_or(u32::MAX)
    });

    if question_fields.is_empty() {
        return None;
    }

    let mut questions = Vec::new();
    for (idx, &(content_field, field)) in question_fields.iter().enumerate() {
        let prompt = last_prompts
            .as_ref()
            .and_then(|prompts| prompts.get(idx))
            .cloned()
            .unwrap_or_else(|| {
                if question_fields.len() == 1 {
                    params
                        .get("message")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| {
                            extract_actual_question(field)
                                .map(|s| s.to_string())
                                .unwrap_or_default()
                        })
                } else {
                    extract_actual_question(field)
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| {
                            params
                                .get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string()
                        })
                }
            });
        let options = extract_enum_options(field)?;
        // 多选：ACP schema 用 {type:"array", items:{anyOf:[...]}};
        // 单选：{type:"string", oneOf:[...]}
        let is_multi_select = field.get("type").and_then(|v| v.as_str()) == Some("array");
        questions.push(AcpQuestion {
            field_name: (*content_field).clone(),
            prompt,
            options,
            is_multi_select,
        });
    }

    Some(AcpElicitation { questions })
}

fn extract_actual_question(field: &serde_json::Value) -> Option<&str> {
    let desc = field.get("description").and_then(|v| v.as_str());
    let title = field.get("title").and_then(|v| v.as_str());
    match (desc, title) {
        (Some(d), Some(t)) => {
            if is_generic_question_title(t) {
                Some(d)
            } else if is_generic_question_title(d) {
                Some(t)
            } else {
                Some(d)
            }
        }
        (Some(d), None) => Some(d),
        (None, Some(t)) => Some(t),
        (None, None) => None,
    }
}

fn is_generic_question_title(s: &str) -> bool {
    let s_trimmed = s.trim();
    if s_trimmed.starts_with("问题") {
        let suffix = s_trimmed.strip_prefix("问题").unwrap().trim();
        return suffix.chars().all(|c| c.is_ascii_digit());
    }
    let lower = s_trimmed.to_ascii_lowercase();
    if lower.starts_with("question") {
        let suffix = lower.strip_prefix("question").unwrap().trim();
        return suffix.chars().all(|c| c.is_ascii_digit());
    }
    false
}

pub(super) fn extract_ask_user_prompts(update: &serde_json::Value) -> Option<Vec<String>> {
    let raw_input = update.get("rawInput").or_else(|| update.get("input"))?;
    let questions = raw_input.get("questions")?.as_array()?;
    let mut prompts = Vec::new();
    for q in questions {
        if let Some(question_text) = q.get("question").and_then(|v| v.as_str()) {
            prompts.push(question_text.to_string());
        }
    }
    if prompts.is_empty() {
        None
    } else {
        Some(prompts)
    }
}

/// A `question_<n>` form field (not the `question_<n>_custom` companion).
pub(super) fn is_question_field(key: &str) -> bool {
    let rest = match key.strip_prefix("question_") {
        Some(r) => r,
        None => return false,
    };
    !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit())
}

/// Extract choice options from a single-select `oneOf` or multi-select
/// `items.anyOf` enum. Each option's `const` is the answer label.
fn extract_enum_options(field: &serde_json::Value) -> Option<Vec<InteractionOption>> {
    let enum_list = field.get("oneOf").and_then(|v| v.as_array()).or_else(|| {
        field
            .get("items")
            .and_then(|i| i.get("anyOf"))
            .and_then(|v| v.as_array())
    })?;

    let options = enum_list
        .iter()
        .filter_map(|opt| {
            // `const` is the clean option label (the tool records it as the answer).
            let const_val = opt.get("const")?.as_str()?;
            // Prefer the structured description carried under ACP's `_meta`
            // extension; fall back to the "label — description" flattened title.
            let description = opt
                .get("_meta")
                .and_then(|m| m.get("_claude/askUserQuestionOption"))
                .and_then(|m| m.get("description"))
                .and_then(|v| v.as_str())
                .map(String::from)
                .or_else(|| {
                    opt.get("title")
                        .and_then(|v| v.as_str())
                        .and_then(|t| t.split_once(" — ").map(|(_, d)| d.to_string()))
                });
            Some(InteractionOption {
                option_id: const_val.to_string(),
                label: const_val.to_string(),
                description,
            })
        })
        .collect();
    Some(options)
}
