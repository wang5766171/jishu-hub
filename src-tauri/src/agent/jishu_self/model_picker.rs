//! v0.8.0 需求3：模型选择聚合（`get_model_picker_options`）。
//!
//! 语义唯一化：models.json 的 thinkingLevelMap/reasoning 解析**只在后端**，
//! 前端（会话页 picker / 模型表单 / 行为页）一律消费聚合结果——消除
//! 「前端复刻 Pi 语义」的三份双源（chat-page 解析块 / model-types 解析 /
//! PI_THINKING_LEVELS 常量）。

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModelPickerOption {
    /// 选择器 value（"provider/model"，与 set_active 的写入值同构）。
    pub value: String,
    /// 展示名（渠道显示名 · 模型 id）。
    pub label: String,
    /// 该模型支持的思考档位（Pi getSupportedThinkingLevels 语义）。
    pub thinking_levels: Vec<String>,
    /// 是否推理模型（false 时档位仅 off）。
    pub reasoning: bool,
}

/// Pi 档位全序（与 pi thinking levels 及前端展示字典一致）。
const THINKING_LEVEL_ALL: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// thinkingLevelMap → 支持档位（与前端 supportedThinkingLevels 逐条对齐，
/// 单测锁定）：
/// - null → 显式不支持（剔除）；
/// - xhigh/max → 需显式声明才包含；
/// - off..high → 未声明默认支持；
/// - 无 map → 默认集 off..high。
pub fn supported_thinking_levels(map: Option<&serde_json::Value>) -> Vec<String> {
    let Some(obj) = map.and_then(serde_json::Value::as_object) else {
        return THINKING_LEVEL_ALL[..5].iter().map(|s| s.to_string()).collect();
    };
    THINKING_LEVEL_ALL
        .iter()
        .filter(|lvl| {
            let mapped = obj.get(**lvl);
            if mapped == Some(&serde_json::Value::Null) {
                return false;
            }
            if **lvl == "xhigh" || **lvl == "max" {
                return mapped.is_some();
            }
            true
        })
        .map(|s| s.to_string())
        .collect()
}

/// 从已加载的 models.json 配置构造 picker 选项。
/// provider 显示名：providers.<key>.name 非空用之，否则回退 key（对齐原前端）。
pub fn picker_options_from_config(config: &serde_json::Value) -> Vec<ModelPickerOption> {
    let mut options = Vec::new();
    let Some(providers) = config.get("providers").and_then(|v| v.as_object()) else {
        return options;
    };
    for (key, value) in providers {
        let display_name = value
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(key);
        let Some(models) = value.get("models").and_then(|v| v.as_array()) else {
            continue;
        };
        for m in models {
            let Some(id) = m.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let reasoning = m.get("reasoning").and_then(|v| v.as_bool()).unwrap_or(true);
            let thinking_levels = if reasoning {
                supported_thinking_levels(m.get("thinkingLevelMap"))
            } else {
                vec!["off".to_string()]
            };
            options.push(ModelPickerOption {
                value: format!("{key}/{id}"),
                label: format!("{display_name} · {id}"),
                thinking_levels,
                reasoning,
            });
        }
    }
    options
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn supported_levels_semantics() {
        // 无 map → 默认集。
        assert_eq!(
            supported_thinking_levels(None),
            vec!["off", "minimal", "low", "medium", "high"]
        );
        // null 剔除 + xhigh/max 需显式声明。
        assert_eq!(
            supported_thinking_levels(Some(&json!({ "minimal": null }))),
            vec!["off", "low", "medium", "high"]
        );
        assert_eq!(
            supported_thinking_levels(Some(&json!({ "xhigh": "xhigh", "max": "max" }))),
            vec!["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        );
        // 显式声明 xhigh 但 max 未声明 → 不含 max。
        assert_eq!(
            supported_thinking_levels(Some(&json!({ "xhigh": "xhigh" })))
                .last()
                .unwrap(),
            "xhigh"
        );
    }

    #[test]
    fn picker_options_from_config_shape() {
        let config = json!({
            "providers": {
                "zhipu": {
                    "name": "智谱",
                    "models": [
                        { "id": "glm-5.3", "reasoning": true, "thinkingLevelMap": { "minimal": null } },
                        { "id": "glm-4-flash", "reasoning": false }
                    ]
                },
                "empty": { "name": "" }
            }
        });
        let opts = picker_options_from_config(&config);
        assert_eq!(opts.len(), 2);
        assert_eq!(opts[0].value, "zhipu/glm-5.3");
        assert_eq!(opts[0].label, "智谱 · glm-5.3");
        assert_eq!(opts[0].thinking_levels, vec!["off", "low", "medium", "high"]);
        assert!(opts[0].reasoning);
        assert_eq!(opts[1].thinking_levels, vec!["off"]);
        assert!(!opts[1].reasoning);
        // 空名渠道回退 key（empty 无模型不产生项——校验无 panic 即可）。
    }
}
