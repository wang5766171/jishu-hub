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

// ── v0.9.2 需求13：会话可选模型可见性 ──
// 规则（用户裁决）：
//   1) 显式记录（model_session_visibility）优先——激活过的模型在激活时
//      写入 visible 记录，保持可见；
//   2) 无记录走默认规则：渠道内按版本倒序前 3 可见；
//   3) 当前激活模型恒可见（且前端禁止对其设不可见）。

/// 模型 id 数字段提取（与前端 model-sort.ts versionSegments 对齐：
/// "glm-5.2-flash-250" → [5,2,250]）。饱和累加防超长数字串溢出。
fn version_segments(id: &str) -> Vec<u64> {
    let mut segs = Vec::new();
    let mut cur: Option<u64> = None;
    for ch in id.chars() {
        if let Some(d) = ch.to_digit(10) {
            cur = Some(cur.unwrap_or(0).saturating_mul(10).saturating_add(d as u64));
        } else if let Some(v) = cur.take() {
            segs.push(v);
        }
    }
    if let Some(v) = cur {
        segs.push(v);
    }
    segs
}

/// 版本倒序比较（与前端 byVersionDesc 同语义，单测锁定）。
fn by_version_desc(a: &str, b: &str) -> std::cmp::Ordering {
    let va = version_segments(a);
    let vb = version_segments(b);
    match (va.is_empty(), vb.is_empty()) {
        (true, true) => b.cmp(a),
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => {
            let len = va.len().max(vb.len());
            for i in 0..len {
                let da = va.get(i).copied().unwrap_or(0);
                let db = vb.get(i).copied().unwrap_or(0);
                if da != db {
                    return db.cmp(&da);
                }
            }
            b.cmp(a)
        }
    }
}

/// 按可见性过滤构造 picker 选项（jishu 专用；其他 agent 走原全量构造）。
/// visibility = 渠道显式记录（provider_key → model_id → hidden）；
/// active = 当前激活 (provider, model)——恒可见。
pub fn picker_options_with_visibility(
    config: &serde_json::Value,
    visibility: &std::collections::HashMap<String, std::collections::HashMap<String, bool>>,
    active: Option<(String, String)>,
) -> Vec<ModelPickerOption> {
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
        // 默认可见集：该渠道配置模型按版本倒序前 3。
        let mut ids: Vec<&str> = models
            .iter()
            .filter_map(|m| m.get("id").and_then(|v| v.as_str()))
            .collect();
        ids.sort_by(|a, b| by_version_desc(a, b));
        let default_visible: std::collections::HashSet<&str> =
            ids.iter().take(3).copied().collect();
        let explicit = visibility.get(key);
        for m in models {
            let Some(id) = m.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let is_active = active
                .as_ref()
                .map(|(p, mid)| p == key && mid == id)
                .unwrap_or(false);
            let visible = is_active
                || match explicit.and_then(|e| e.get(id)) {
                    Some(hidden) => !*hidden,
                    None => default_visible.contains(id),
                };
            if !visible {
                continue;
            }
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

    // ── 需求13：可见性过滤 ──

    fn vis_config() -> serde_json::Value {
        json!({
            "providers": {
                "zhipu": {
                    "name": "智谱",
                    "models": [
                        { "id": "glm-5.2" },
                        { "id": "glm-5.3" },
                        { "id": "glm-5.1" },
                        { "id": "glm-4.5" }
                    ]
                }
            }
        })
    }

    fn values(opts: &[ModelPickerOption]) -> Vec<String> {
        opts.iter().map(|o| o.value.clone()).collect()
    }

    #[test]
    fn visibility_default_top3() {
        // 无显式记录：版本倒序前 3 可见（5.3/5.2/5.1），4.5 不可见。
        let opts = picker_options_with_visibility(&vis_config(), &Default::default(), None);
        assert_eq!(
            values(&opts),
            vec!["zhipu/glm-5.2", "zhipu/glm-5.3", "zhipu/glm-5.1"]
        );
    }

    #[test]
    fn visibility_explicit_overrides_and_active_wins() {
        // 显式隐藏 5.3（默认可见）+ 显式可见 4.5（默认不可见）。
        let mut explicit = std::collections::HashMap::new();
        let mut inner = std::collections::HashMap::new();
        inner.insert("glm-5.3".to_string(), true);
        inner.insert("glm-4.5".to_string(), false);
        explicit.insert("zhipu".to_string(), inner);
        let opts = picker_options_with_visibility(&vis_config(), &explicit, None);
        assert_eq!(
            values(&opts),
            vec!["zhipu/glm-5.2", "zhipu/glm-5.1", "zhipu/glm-4.5"]
        );
        // 当前激活模型恒可见（即使显式隐藏）。
        let opts = picker_options_with_visibility(
            &vis_config(),
            &explicit,
            Some(("zhipu".into(), "glm-5.3".into())),
        );
        assert!(values(&opts).contains(&"zhipu/glm-5.3".to_string()));
    }

    #[test]
    fn version_desc_matches_frontend_semantics() {
        assert_eq!(by_version_desc("glm-5.3", "glm-5.2"), std::cmp::Ordering::Less);
        assert_eq!(
            by_version_desc("glm-4.5", "glm-5.1"),
            std::cmp::Ordering::Greater
        );
        // 同版本 tie-break 字典序倒序。
        assert_eq!(
            by_version_desc("gpt-5.6-terra", "gpt-5.6-luna"),
            std::cmp::Ordering::Less
        );
        // 无数字排最后。
        assert_eq!(by_version_desc("custom", "glm-4.5"), std::cmp::Ordering::Greater);
    }
}
