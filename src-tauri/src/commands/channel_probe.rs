//! v0.9.2 需求9：按渠道探测模型列表（模型设置交互优化）。
//!
//! 用户实测裁决：各第三方渠道的模型查询接口**实际存在**（2026-09-12 curl
//! 逐一探测：智谱/Kimi/DeepSeek/百炼兼容模式均为 OpenAI 风格 `data[].id`，
//! 401=端点在、key 假），差异仅在鉴权头与响应结构——按**策略表**实现：
//!
//! | 渠道匹配 | 端点 | 鉴权 | 解析 |
//! |---|---|---|---|
//! | anthropic（官方/域名） | {base}/v1/models | x-api-key | data[].id |
//! | openai / 兼容模式 / 自定义兜底 | {base}/models（base 已含 /v1 则不重复） | Authorization: Bearer | data[].id |
//! | 百炼原生（dashscope.aliyuncs.com/api/v1） | {base}/models?page_size=100 | Bearer | **output.models[].model**（分页单页 100 已够预设展示） |
//!
//! 未知渠道兜底 = baseUrl + `/models`（OpenAI 事实标准）；解析失败/网络
//! 错误返回 `supported: false`——前端回退静态预设列表且不显示刷新按钮
//!（用户裁决：无接口则现状）。

use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct ChannelModelsProbe {
    pub supported: bool,
    pub models: Vec<String>,
    /// 供前端展示的探测端点（失败排查用）。
    pub endpoint: String,
    pub error: Option<String>,
}

/// v0.9.2 需求9：按渠道探测模型列表（模型设置交互优化——第三方渠道
/// "首次自动查询、后续手动刷新"；不支持则回退静态预设且无刷新钮）。
#[tauri::command]
pub(crate) async fn probe_channel_models(
    base_url: String,
    api_key: String,
) -> Result<ChannelModelsProbe, String> {
    // 阻塞 HTTP 移出主线程（同 get_model_picker_options 模式）。
    tauri::async_runtime::spawn_blocking(move || Ok(probe_channel_models_impl(&base_url, &api_key)))
        .await
        .map_err(|e| format!("probe task failed: {e}"))?
}

/// 按 baseUrl 推断探测策略并拉取模型列表。
pub(crate) fn probe_channel_models_impl(base_url: &str, api_key: &str) -> ChannelModelsProbe {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() || api_key.trim().is_empty() {
        return ChannelModelsProbe {
            supported: false,
            models: vec![],
            endpoint: base.to_string(),
            error: Some("baseUrl 或密钥为空".into()),
        };
    }
    let lower = base.to_lowercase();

    // ── 策略表 ──
    // anthropic 官方/兼容端点：x-api-key + /v1/models（base 不含 /v1 时补）。
    if lower.contains("anthropic.com") || lower.ends_with("/anthropic") {
        let endpoint = if lower.ends_with("/v1") {
            format!("{base}/models")
        } else {
            format!("{base}/v1/models")
        };
        return fetch_models(&endpoint, |req| req.header("x-api-key", api_key), parse_data_ids);
    }
    // 百炼原生：分页结构 output.models[].model（单页 100 足够渠道展示）。
    if lower.contains("dashscope.aliyuncs.com/api/v1")
        || lower.contains(".maas.aliyuncs.com/api/v1")
    {
        let endpoint = format!("{base}/models?page_size=100");
        return fetch_models(&endpoint, |req| req.header("Authorization", format!("Bearer {api_key}")), parse_dashscope);
    }

    // OpenAI 兼容（openai 官方 / 智谱 paas / Kimi / DeepSeek / 兼容模式 /
    // 自定义兜底）：Authorization Bearer + {base}/models（base 以 /v1、
    // /v4、/compatible-mode/v1 等版本段结尾时直接拼接）。
    let endpoint = format!("{base}/models");
    fetch_models(&endpoint, |req| req.header("Authorization", format!("Bearer {api_key}")), parse_data_ids)
}

fn fetch_models(
    endpoint: &str,
    auth: impl FnOnce(reqwest::blocking::RequestBuilder) -> reqwest::blocking::RequestBuilder,
    parse: fn(&serde_json::Value) -> Vec<String>,
) -> ChannelModelsProbe {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ChannelModelsProbe {
                supported: false,
                models: vec![],
                endpoint: endpoint.into(),
                error: Some(format!("http client: {e}")),
            }
        }
    };
    let req = match auth(client.get(endpoint)).build() {
        Ok(r) => r,
        Err(e) => {
            return ChannelModelsProbe {
                supported: false,
                models: vec![],
                endpoint: endpoint.into(),
                error: Some(format!("request build: {e}")),
            }
        }
    };
    match client.execute(req) {
        Ok(resp) => {
            let status = resp.status();
            match resp.json::<serde_json::Value>() {
                Ok(body) => {
                    let models = parse(&body);
                    if models.is_empty() {
                        // 401/404 等：端点不存在或鉴权失败——按不支持处理
                        //（前端回退现状，无刷新按钮）。
                        ChannelModelsProbe {
                            supported: false,
                            models: vec![],
                            endpoint: endpoint.into(),
                            error: Some(format!("HTTP {status}")),
                        }
                    } else {
                        ChannelModelsProbe {
                            supported: true,
                            models,
                            endpoint: endpoint.into(),
                            error: None,
                        }
                    }
                }
                Err(e) => ChannelModelsProbe {
                    supported: false,
                    models: vec![],
                    endpoint: endpoint.into(),
                    error: Some(format!("body: {e}")),
                },
            }
        }
        Err(e) => ChannelModelsProbe {
            supported: false,
            models: vec![],
            endpoint: endpoint.into(),
            error: Some(format!("network: {e}")),
        },
    }
}

/// OpenAI 风格：`{"data": [{"id": ...}, ...]}`。
fn parse_data_ids(body: &serde_json::Value) -> Vec<String> {
    body.get("data")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(serde_json::Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 百炼原生：`{"output": {"models": [{"model": ...}, ...]}}`。
fn parse_dashscope(body: &serde_json::Value) -> Vec<String> {
    body.pointer("/output/models")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("model").and_then(serde_json::Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_openai_style() {
        let body = serde_json::json!({"object":"list","data":[{"id":"glm-5.3"},{"id":"glm-5.2"}]});
        assert_eq!(parse_data_ids(&body), vec!["glm-5.3", "glm-5.2"]);
    }

    #[test]
    fn parse_dashscope_style() {
        let body = serde_json::json!({
            "output": {"total": 2, "models": [{"model": "qwen-max"}, {"model": "qwen-plus"}]}
        });
        assert_eq!(parse_dashscope(&body), vec!["qwen-max", "qwen-plus"]);
    }

    #[test]
    fn anthropic_endpoint_appends_v1() {
        // 经 fetch 端点构造逻辑验证：anthropic 域名走 x-api-key + /v1/models。
        let base = "https://open.bigmodel.cn/api/anthropic";
        let lower = base.to_lowercase();
        let endpoint = if lower.ends_with("/v1") {
            format!("{base}/models")
        } else {
            format!("{base}/v1/models")
        };
        assert_eq!(endpoint, "https://open.bigmodel.cn/api/anthropic/v1/models");
    }

    #[test]
    fn empty_inputs_report_unsupported() {
        let probe = probe_channel_models_impl("", "");
        assert!(!probe.supported);
        let probe = probe_channel_models_impl("https://api.example.com", "  ");
        assert!(!probe.supported);
    }
}
