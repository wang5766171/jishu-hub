use super::handle_hub_invoke;

/// v0.9.5 需求5 测试期 T1：rpiv-ask 哨兵行判定——精确匹配
/// "N. Type something."（N 为纯数字），其他形态（含正常选项）不命中。
#[test]
fn sentinel_option_detection() {
    assert!(super::is_sentinel_option("4. Type something."));
    assert!(super::is_sentinel_option("1. Type something."));
    assert!(!super::is_sentinel_option("1. 红 — 红色选项"));
    assert!(!super::is_sentinel_option("Type something."));
    assert!(!super::is_sentinel_option("x. Type something."));
    assert!(!super::is_sentinel_option("12. Type something. extra"));
}

/// T1 ①：select 末项哨兵剥离 + 登记；非 select / 无哨兵原样返回。
#[test]
fn strip_sentinel_from_select_request() {
    let msg = serde_json::json!({
        "type": "extension_ui_request",
        "method": "select",
        "id": "t1-strip",
        "title": "颜色？",
        "options": ["1. 红 — 红", "2. 绿 — 绿", "3. Type something."]
    });
    let stripped = super::strip_sentinel_option(msg.clone());
    let options = stripped["options"].as_array().unwrap();
    assert_eq!(options.len(), 2);
    assert_eq!(options[0].as_str().unwrap(), "1. 红 — 红");
    // 登记可取回（取用即消费）
    {
        let mut reg = super::interaction_sentinels()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            reg.remove("t1-strip").as_deref(),
            Some("3. Type something.")
        );
    }
    // 无哨兵：原样
    let plain = serde_json::json!({
        "method": "select", "id": "t1-plain", "options": ["a", "b"]
    });
    assert_eq!(super::strip_sentinel_option(plain.clone()), plain);
    // input 方法：不动
    let input = serde_json::json!({"method": "input", "id": "t1-in", "title": "q"});
    assert_eq!(super::strip_sentinel_option(input.clone()), input);
}

/// v0.9.5 需求5 测试期 T5：多选题 input 还原——题干含序号选项块 +
/// 英文序号说明 → 改写 multiSelect（题干=问句、选项=序号行）；非该
/// 形态（普通 input / 选项块非全序号 / select）原样返回。
#[test]
fn multiselect_input_restored_from_rpc_fallback() {
    let msg = serde_json::json!({
        "type": "extension_ui_request",
        "method": "input",
        "id": "t5-multi",
        "title": "[多选题] 哪些鸟不会飞？

1. 企鹅 — 南极
2. 鸵鸟 — 最大
3. 天鹅 — 会飞

Enter the numbers of all that apply, comma-separated (e.g. \"1,3\"), or type a custom answer as plain text.",
        "placeholder": "1,3"
    });
    let rewritten = super::rewrite_multiselect_input(msg);
    assert_eq!(rewritten["method"].as_str().unwrap(), "multiSelect");
    assert_eq!(
        rewritten["title"].as_str().unwrap(),
        "[多选题] 哪些鸟不会飞？"
    );
    let options = rewritten["options"].as_array().unwrap();
    assert_eq!(options.len(), 3);
    assert_eq!(options[0].as_str().unwrap(), "1. 企鹅 — 南极");
    assert!(super::multi_select_requests()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove("t5-multi"));

    // 普通 input（无英文说明）不动
    let plain = serde_json::json!({"method": "input", "id": "t5-plain", "title": "随便说点什么"});
    assert_eq!(super::rewrite_multiselect_input(plain.clone()), plain);
    // 选项块含非序号行 → 不还原（防误伤含空行的题干）
    let bad = serde_json::json!({
        "method": "input", "id": "t5-bad",
        "title": "问题

1. 企鹅 — 南极
补充说明一行

Enter the numbers of all that apply, comma-separated (e.g. \"1,3\"), or type a custom answer as plain text."
    });
    assert_eq!(super::rewrite_multiselect_input(bad.clone()), bad);
    // select 方法不动
    let sel =
        serde_json::json!({"method": "select", "id": "t5-sel", "title": "x", "options": ["1. a"]});
    assert_eq!(super::rewrite_multiselect_input(sel.clone()), sel);
}

/// T5 ②：多选卡应答翻译——选中序号行 → "1,3"；纯自定义文本透传；
/// 未登记的请求原样返回。
#[test]
fn multiselect_response_translated_to_indices() {
    {
        let mut reg = super::multi_select_requests()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reg.insert("t5-rw".to_string());
    }
    let interaction = serde_json::json!({
        "selected_options": ["1. 企鹅 — 南极", "3. 天鹅 — 会飞"]
    });
    assert_eq!(
        super::rewrite_multiselect_response(
            "t5-rw",
            "1. 企鹅 — 南极
3. 天鹅 — 会飞",
            Some(&interaction)
        ),
        "1,3"
    );
    // 已消费：再答原样
    assert_eq!(
        super::rewrite_multiselect_response("t5-rw", "再来", Some(&interaction)),
        "再来"
    );
    // 纯自定义（无选中）透传
    {
        let mut reg = super::multi_select_requests()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reg.insert("t5-custom".to_string());
    }
    let custom = serde_json::json!({"selected_options": []});
    assert_eq!(
        super::rewrite_multiselect_response("t5-custom", "鹦鹉不会飞", Some(&custom)),
        "鹦鹉不会飞"
    );
    // 未登记请求不动
    assert_eq!(
        super::rewrite_multiselect_response("t5-unknown", "1. a", Some(&interaction)),
        "1. a"
    );
}

/// 四轮评审 P2-1：resolve 键迁移——pending 键的挂起应答随迁到真实 id；
/// 真实键已有值时保守不覆盖；同 id 不动。
#[test]
fn auto_answer_key_migration_on_resolve() {
    {
        let mut reg = super::interaction_auto_answer()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reg.insert("p21-pending".to_string(), "答案A".to_string());
    }
    super::migrate_auto_answer_key("p21-pending", "p21-real");
    {
        let reg = super::interaction_auto_answer()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        assert!(reg.get("p21-pending").is_none());
        assert_eq!(reg.get("p21-real").map(String::as_str), Some("答案A"));
    }
    // 真实键已有值：保守不覆盖（迁移值丢弃）
    {
        let mut reg = super::interaction_auto_answer()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reg.insert("p21-pending2".to_string(), "旧答案".to_string());
        reg.insert("p21-real2".to_string(), "已有答案".to_string());
    }
    super::migrate_auto_answer_key("p21-pending2", "p21-real2");
    {
        let reg = super::interaction_auto_answer()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        assert_eq!(reg.get("p21-real2").map(String::as_str), Some("已有答案"));
        assert!(reg.get("p21-pending2").is_none());
    }
    // 同 id：无操作（不丢已有值）
    super::migrate_auto_answer_key("p21-real", "p21-real");
    {
        let reg = super::interaction_auto_answer()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        assert_eq!(reg.get("p21-real").map(String::as_str), Some("答案A"));
    }
    // 清理（全局静态表，防污染其他用例）
    {
        let mut reg = super::interaction_auto_answer()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reg.remove("p21-real");
        reg.remove("p21-real2");
    }
}

/// T1 ②：应答改写——无选中项纯文本 + 挂有哨兵 → 回传哨兵并暂存文本；
/// 有选中项 / 未挂哨兵 → 原样。
#[test]
fn sentinel_response_rewrite_rules() {
    // 准备登记（本测试独立 key）
    {
        let mut reg = super::interaction_sentinels()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reg.insert("t2-rw".to_string(), "3. Type something.".to_string());
    }
    let interaction = serde_json::json!({"selected_options": []});
    let rewritten =
        super::rewrite_sentinel_response("t2-rw", "t2-session", "自定义：蓝色", Some(&interaction));
    assert_eq!(rewritten, "3. Type something.");
    // 暂存文本可取（消费式）
    {
        let mut stash = super::interaction_auto_answer()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        assert_eq!(stash.remove("t2-session").as_deref(), Some("自定义：蓝色"));
    }
    // 已消费（登记被取走）：再次应答原样返回
    assert_eq!(
        super::rewrite_sentinel_response("t2-rw", "t2-session", "再来一次", Some(&interaction)),
        "再来一次"
    );
    // 有选中项（普通选项点击）：即使挂哨兵也不改写
    {
        let mut reg = super::interaction_sentinels()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reg.insert("t2-opt".to_string(), "3. Type something.".to_string());
    }
    let with_selection = serde_json::json!({"selected_options": ["1. 红 — 红"]});
    assert_eq!(
        super::rewrite_sentinel_response("t2-opt", "s", "1. 红 — 红", Some(&with_selection)),
        "1. 红 — 红"
    );
}

// v0.9.2 测试期：plugin_preview_html 校验阶梯——文件存在性/扩展名/大小
// 逐级拒绝；合法文件在无 Hub 句柄的测试环境落到「界面未就绪」分支
//（证明前两级校验已通过）。
#[test]
fn plugin_preview_html_rejects_missing_file() {
    let err = handle_hub_invoke(
        "plugin_preview_html",
        &serde_json::json!({"file": "Z:/definitely/not/there.html"}),
    )
    .unwrap_err();
    assert!(err.contains("不存在"), "unexpected: {err}");
}

// v0.9.3 测试期（前端项目预览）：url 模式回环校验——仅本机
// localhost/127.0.0.1/[::1] 的 http/https 放行，其余（外网/内网/非
// http scheme）拒绝；合法 url 在无 Hub 句柄环境落到「界面未就绪」。
#[test]
fn plugin_preview_html_url_loopback_ladder() {
    for bad in [
        "http://example.com:5173",
        "http://192.0.2.10:3000",
        "file://localhost/x",
        "ftp://localhost",
        "http://localhost.evil.com",
    ] {
        let err =
            handle_hub_invoke("plugin_preview_html", &serde_json::json!({"url": bad})).unwrap_err();
        // 各级拒绝（scheme/回环）皆可，断言核心：到不了「界面未就绪」
        //（即校验全部放行的路径）。
        assert!(
            !err.contains("未就绪"),
            "url={bad} should be rejected: {err}"
        );
    }
    for ok in [
        "http://localhost:5173",
        "http://127.0.0.1:3000/index.html",
        "https://localhost",
    ] {
        let err =
            handle_hub_invoke("plugin_preview_html", &serde_json::json!({"url": ok})).unwrap_err();
        assert!(
            err.contains("未就绪"),
            "url={ok} should pass validation: {err}"
        );
    }
}

#[test]
fn plugin_preview_html_rejects_non_html_extension() {
    let md = std::env::temp_dir().join(format!("jishu-hub-preview-{}.md", std::process::id()));
    std::fs::write(&md, "x").unwrap();
    let err = handle_hub_invoke(
        "plugin_preview_html",
        &serde_json::json!({"file": md.to_string_lossy()}),
    )
    .unwrap_err();
    assert!(err.contains(".html"), "unexpected: {err}");
    let _ = std::fs::remove_file(&md);
}

#[test]
fn plugin_preview_html_valid_file_reaches_hub_gate() {
    let html = std::env::temp_dir().join(format!("jishu-hub-preview-{}.html", std::process::id()));
    std::fs::write(&html, "<!DOCTYPE html><html></html>").unwrap();
    // 测试环境未注册 HUB_APP_HANDLE：合法文件应越过存在性/扩展名校验，
    // 落到「Hub 界面未就绪」而非文件错误。
    let err = handle_hub_invoke(
        "plugin_preview_html",
        &serde_json::json!({"file": html.to_string_lossy()}),
    )
    .unwrap_err();
    assert!(err.contains("未就绪"), "unexpected: {err}");
    let _ = std::fs::remove_file(&html);
}

/// 真实形态回归：写小说场景的分段（thinking + text + toolCall=write +
/// toolResults），验证分段记账的精确字段与内容归因。
#[test]
fn pi_segment_usage_attributes_realistic_turn_end() {
    let event = serde_json::json!({
        "type": "turn_end",
        "message": {
            "role": "assistant",
            "stopReason": "toolUse",
            "content": [
                {"type": "thinking", "thinking": "规划第一章结构", "thinkingSignature": "sig"},
                {"type": "text", "text": "我先写入第一章。"},
                {"type": "toolCall", "id": "call_1", "name": "write",
                 "arguments": {"path": "novel.md", "content": "第一章 雾夜坠楼。江州的雾，是有脾气的。"}}
            ],
            "usage": {
                "input": 1166, "output": 1380, "cacheRead": 113472,
                "cacheWrite": 0, "totalTokens": 116018,
                "cost": {"total": 0.0123}
            }
        },
        "toolResults": [
            {"role": "toolResult", "toolCallId": "call_1", "toolName": "write",
             "content": [{"type": "text", "text": "Written 42 lines."}]}
        ]
    });
    let seg = pi_segment_usage(&event, Some(1_000_000)).unwrap();
    assert_eq!(seg.stop_reason, "toolUse");
    assert_eq!(seg.input_tokens, 1166);
    assert_eq!(seg.output_tokens, 1380);
    assert_eq!(seg.cache_read, 113_472);
    assert_eq!(seg.total_tokens, 116_018);
    assert!((seg.total_cost - 0.0123).abs() < 1e-9);
    assert_eq!(seg.context_remaining, Some(1_000_000 - 116_018));
    // 归因：三块皆有值；工具调用一次（MCP 无标志并入工具桶）。
    assert!(seg.est_thinking > 0);
    assert!(seg.est_text > 0);
    assert!(seg.est_builtin_tool > 0);
    assert_eq!(seg.est_mcp_tool, 0);
    assert_eq!(seg.tool_calls, 1);
    assert_eq!(seg.mcp_calls, 0);
    assert!(seg.est_tool_results > 0);
}

/// 真实形态回归：compaction_end（threshold 触发，含 CompactionResult）。
#[test]
fn pi_compaction_record_extracts_result_fields() {
    let event = serde_json::json!({
        "type": "compaction_end",
        "reason": "threshold",
        "aborted": false,
        "result": {
            "summary": "## Goal
    - 用户要求写 20 万字小说",
            "firstKeptEntryId": "entry-42",
            "tokensBefore": 118_910,
            "estimatedTokensAfter": 62_389,
            "usage": {"input": 110_000, "output": 6_340, "totalTokens": 116_340,
                      "cost": {"total": 0.08}}
        }
    });
    let rec = pi_compaction_record(&event);
    assert_eq!(rec.reason, "threshold");
    assert!(!rec.aborted);
    assert_eq!(rec.tokens_before, 118_910);
    assert_eq!(rec.tokens_after, 62_389);
    assert_eq!(rec.first_kept_entry_id.as_deref(), Some("entry-42"));
    assert_eq!(rec.summary_input, 110_000);
    assert_eq!(rec.summary_output, 6_340);
    assert!((rec.summary_cost - 0.08).abs() < 1e-9);
    assert!(rec.est_summary > 0);

    // result 缺失（压缩失败）——字段全缺省，不 panic。
    let empty = pi_compaction_record(&serde_json::json!({
        "type": "compaction_end", "reason": "manual", "aborted": true
    }));
    assert!(empty.aborted);
    assert_eq!(empty.tokens_before, 0);
    assert_eq!(empty.first_kept_entry_id, None);
}

#[test]
fn pi_turn_usage_maps_turn_end_usage_with_watermark() {
    let event = serde_json::json!({
        "type": "turn_end",
        "message": {
            "stopReason": "end_turn",
            "usage": {
                "input": 1000,
                "output": 300,
                "cacheRead": 60000,
                "cacheWrite": 0,
                "totalTokens": 61300,
                "cost": { "total": 0.05 }
            }
        }
    });
    let usage = pi_turn_usage(&event, Some(128_000)).unwrap();
    assert_eq!(usage.input_tokens, Some(1000));
    assert_eq!(usage.output_tokens, Some(300));
    assert_eq!(usage.total_cost, Some(0.05));
    assert_eq!(usage.context_window_total, Some(128_000));
    // totalTokens 优先（对齐 pi calculateContextTokens），remaining = 128k - 61.3k
    assert_eq!(usage.context_remaining, Some(128_000 - 61_300));

    // totalTokens 缺省时回退四项求和
    let event2 = serde_json::json!({
        "message": { "usage": { "input": 10, "output": 5, "cacheRead": 5, "cacheWrite": 0 } }
    });
    let usage2 = pi_turn_usage(&event2, Some(100)).unwrap();
    assert_eq!(usage2.context_remaining, Some(80));

    // 无 usage / 全空 → None
    assert!(pi_turn_usage(&serde_json::json!({ "message": {} }), Some(100)).is_none());
    // ctx 未知 → remaining/total 为 None，in/out 仍上报
    let usage3 = pi_turn_usage(&event2, None).unwrap();
    assert_eq!(usage3.context_remaining, None);
    assert_eq!(usage3.input_tokens, Some(10));
}

#[test]
fn turn_end_maps_usage_into_turn_complete() {
    let event = serde_json::json!({
        "type": "turn_end",
        "message": {
            "stopReason": "end_turn",
            "usage": { "input": 10, "output": 2, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 12, "cost": { "total": 0.01 } }
        }
    });
    let events = normalize_pi_agent_event(&event, Some(1000), &mut Vec::new());
    assert_eq!(events.len(), 1);
    match &events[0] {
        NormalizedEvent::TurnComplete { usage, .. } => {
            let u = usage.as_ref().unwrap();
            assert_eq!(u.context_window_total, Some(1000));
            assert_eq!(u.context_remaining, Some(988));
        }
        other => panic!("unexpected event: {other:?}"),
    }
}

/// v0.9.1 需求14：auto_retry_start/end 归一化——字段透传 + end 失败
/// 携最终原因。
#[test]
fn auto_retry_events_normalize_to_status() {
    let mut steers = Vec::new();
    let start = normalize_pi_agent_event(
        &serde_json::json!({
            "type": "auto_retry_start",
            "attempt": 2,
            "maxAttempts": 10,
            "delayMs": 4000,
            "errorMessage": "provider 503"
        }),
        None,
        &mut steers,
    );
    assert_eq!(start.len(), 1);
    match &start[0] {
        NormalizedEvent::AutoRetryStatus {
            active,
            attempt,
            max_attempts,
            delay_ms,
            error_message,
            success,
            final_error,
        } => {
            assert!(active);
            assert_eq!((*attempt, *max_attempts, *delay_ms), (2, 10, 4000));
            assert_eq!(error_message, "provider 503");
            assert!(!success);
            assert!(final_error.is_none());
        }
        other => panic!("unexpected {other:?}"),
    }

    let end = normalize_pi_agent_event(
        &serde_json::json!({
            "type": "auto_retry_end",
            "success": false,
            "attempt": 10,
            "finalError": "all retries exhausted"
        }),
        None,
        &mut steers,
    );
    match &end[0] {
        NormalizedEvent::AutoRetryStatus {
            active,
            success,
            final_error,
            ..
        } => {
            assert!(!active);
            assert!(!success);
            assert_eq!(final_error.as_deref(), Some("all retries exhausted"));
        }
        other => panic!("unexpected {other:?}"),
    }
}

/// v0.9.1 需求3 #2：compaction_end 三态呈现——成功「已压缩」、aborted
/// 「已取消」、errorMessage「失败 + Error(recoverable)」。字段形态对齐
/// pi agent-session catch 分支（errorMessage 仅非 abort 失败时下发）。
#[test]
fn compaction_end_renders_success_aborted_and_failure_states() {
    let success = normalize_pi_agent_event(
        &serde_json::json!({
            "type": "compaction_end", "reason": "threshold",
            "result": {"tokensBefore": 100, "estimatedTokensAfter": 50},
            "aborted": false
        }),
        None,
        &mut Vec::new(),
    );
    assert!(matches!(
        success.as_slice(),
        [
            NormalizedEvent::PhaseDivider { title, .. },
            NormalizedEvent::CompactionStatus { active: false, .. }
        ] if title == "上下文已压缩"
    ));

    let aborted = normalize_pi_agent_event(
        &serde_json::json!({
            "type": "compaction_end", "reason": "manual",
            "result": null, "aborted": true
        }),
        None,
        &mut Vec::new(),
    );
    assert!(matches!(
        aborted.as_slice(),
        [
            NormalizedEvent::PhaseDivider { title, .. },
            NormalizedEvent::CompactionStatus { active: false, .. }
        ] if title == "上下文压缩已取消"
    ));

    let failed = normalize_pi_agent_event(
        &serde_json::json!({
            "type": "compaction_end", "reason": "manual",
            "result": null, "aborted": false,
            "errorMessage": "Compaction failed: provider 500"
        }),
        None,
        &mut Vec::new(),
    );
    assert!(matches!(
        failed.as_slice(),
        [
            NormalizedEvent::PhaseDivider { title, .. },
            NormalizedEvent::CompactionStatus { active: false, .. },
            NormalizedEvent::Error { message, recoverable: true }
        ] if title == "上下文压缩失败" && message.contains("provider 500")
    ));
}

/// v0.9.8 需求7 补充轮 UC-11：引擎的摘要生成重试（压缩期间摘要调用失败后
/// 重试）归一为既有的重试状态——界面显示「第 N/M 次重试（原因）」；重试
/// 结束只清横幅、不带失败原因（成败由随后的 compaction_end 呈现）。
#[test]
fn summarization_retry_events_normalize_to_retry_status() {
    let scheduled = normalize_pi_agent_event(
        &serde_json::json!({
            "type": "summarization_retry_scheduled",
            "attempt": 2, "maxAttempts": 3, "delayMs": 4000,
            "errorMessage": "529 overloaded"
        }),
        None,
        &mut Vec::new(),
    );
    assert!(matches!(
        scheduled.as_slice(),
        [NormalizedEvent::AutoRetryStatus {
            active: true, attempt: 2, max_attempts: 3, delay_ms: 4000,
            ref error_message, success: false, final_error: None
        }] if error_message.as_str() == "529 overloaded"
    ));

    let finished = normalize_pi_agent_event(
        &serde_json::json!({ "type": "summarization_retry_finished" }),
        None,
        &mut Vec::new(),
    );
    assert!(matches!(
        finished.as_slice(),
        [NormalizedEvent::AutoRetryStatus {
            active: false,
            success: false,
            final_error: None,
            ..
        }]
    ));

    // 重试开始事件不产生界面事件（横幅已在 scheduled 时显示）。
    assert!(normalize_pi_agent_event(
        &serde_json::json!({
            "type": "summarization_retry_attempt_start",
            "source": "compaction", "reason": "manual"
        }),
        None,
        &mut Vec::new(),
    )
    .is_empty());
}

use super::*;

#[test]
fn waits_for_agent_settled_before_completing_prompt() {
    assert!(!pi_prompt_is_settled("agent_end"));
    assert!(!pi_prompt_is_settled("turn_end"));
    assert!(pi_prompt_is_settled("agent_settled"));
}

/// R4 root cause, pinned so a future change cannot silently undo it.
///
/// A `turn_end` carrying `stopReason == "toolUse"` yields no events at all --
/// intentionally, so a mid-turn tool call cannot make the GUI drop its
/// streaming state early.  The consequence is that a tool returning
/// `terminate: true` produces *no* TurnComplete anywhere, which is why the
/// settle branch in `run_loop` has to synthesise one (B2.5 T3).
///
/// v0.9.4 需求8：tool_execution_update → ToolUseProgress（partialResult
/// 透传不解析；无 callId 丢弃）。
#[test]
fn tool_execution_update_maps_to_progress() {
    let events = normalize_pi_agent_event(
        &json!({
            "type": "tool_execution_update",
            "toolCallId": "call-1",
            "toolName": "bash",
            "partialResult": {
                "content": [{ "type": "text", "text": "step 3/45 done" }],
                "details": { "fullOutputPath": null }
            }
        }),
        None,
        &mut Vec::new(),
    );
    assert_eq!(events.len(), 1);
    match &events[0] {
        NormalizedEvent::ToolUseProgress {
            call_id,
            partial_output,
        } => {
            assert_eq!(call_id, "call-1");
            assert_eq!(partial_output, "step 3/45 done");
        }
        other => panic!("Expected ToolUseProgress, got {other:?}"),
    }

    // 兜底形状（output 直出）：也能提取。
    let events = normalize_pi_agent_event(
        &json!({
            "type": "tool_execution_update",
            "toolCallId": "call-1b",
            "toolName": "bash",
            "partialResult": { "output": "legacy shape" }
        }),
        None,
        &mut Vec::new(),
    );
    assert_eq!(events.len(), 1);
    match &events[0] {
        NormalizedEvent::ToolUseProgress { partial_output, .. } => {
            assert_eq!(partial_output, "legacy shape");
        }
        other => panic!("Expected ToolUseProgress, got {other:?}"),
    }

    // 无 callId：丢弃（防御）。
    let events = normalize_pi_agent_event(
        &json!({
            "type": "tool_execution_update",
            "toolName": "bash",
            "partialResult": { "output": "x" }
        }),
        None,
        &mut Vec::new(),
    );
    assert!(events.is_empty(), "no callId should be dropped: {events:?}");
}

#[test]
fn tool_use_turn_end_yields_no_events() {
    let events = normalize_pi_agent_event(
        &json!({
            "type": "turn_end",
            "message": { "stopReason": "toolUse" }
        }),
        None,
        &mut Vec::new(),
    );
    assert!(
        events.is_empty(),
        "toolUse turn_end must stay suppressed, got {events:?}"
    );
}

/// Counterpart to the above: a normal turn boundary does produce the
/// completion that `agent_settled` later forwards.
#[test]
fn normal_turn_end_yields_turn_complete() {
    let events = normalize_pi_agent_event(
        &json!({
            "type": "turn_end",
            "message": { "stopReason": "end_turn" }
        }),
        None,
        &mut Vec::new(),
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, NormalizedEvent::TurnComplete { .. })),
        "expected TurnComplete, got {events:?}"
    );
}

#[test]
fn ignores_request_user_input_tool_start_until_extension_ui_request_arrives() {
    let events = normalize_pi_agent_event(
        &json!({
            "type": "tool_execution_start",
            "toolCallId": "call-1",
            "toolName": "request_user_input",
            "args": {
                "question": "请选择发布方式",
                "options": ["A", "B"]
            }
        }),
        None,
        &mut Vec::new(),
    );

    assert!(events.is_empty());
}

#[test]
fn detects_custom_role_phase_enter_marker() {
    let events = normalize_pi_agent_event(
        &json!({
            "type": "message_start",
            "message": {
                "role": "custom",
                "customType": "jishu-conductor:phase-enter:plan",
                "content": "进入流程规划阶段",
                "display": true,
                "timestamp": 0
            }
        }),
        None,
        &mut Vec::new(),
    );

    match events.as_slice() {
        [NormalizedEvent::PhaseDivider { phase, title }] => {
            assert_eq!(phase, "plan");
            assert_eq!(title, "流程规划");
        }
        other => panic!("expected phase divider, got {other:?}"),
    }
}

#[test]
fn surfaces_user_role_message_start_as_steer_injected() {
    // Pi 对每条送达的用户消息都回显 message_start(role=user)——只有
    // 经 Steer 命令注入（连接循环登记进 pending_steers）的才是真引导。
    let event = json!({
        "type": "message_start",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": "改用 TypeScript 实现" }],
            "timestamp": 0
        }
    });

    // 登记过的 steer 文本 → SteerInjected（并消费登记）。
    let mut steers = vec!["改用 TypeScript 实现".to_string()];
    let events = normalize_pi_agent_event(&event, None, &mut steers);
    match events.as_slice() {
        [NormalizedEvent::SteerInjected { content }] => {
            assert_eq!(content, "改用 TypeScript 实现");
        }
        other => panic!("expected [SteerInjected], got {other:?}"),
    }
    assert!(steers.is_empty(), "steer 登记应被消费");

    // 未登记（普通 prompt / 压缩前排队的消息回显）→ 不产生事件，
    // 否则用户消息会被误标「已引导」并重复渲染（v0.8.0 需求10 修复）。
    let events = normalize_pi_agent_event(
        &json!({
            "type": "message_start",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "继续" }],
                "timestamp": 0
            }
        }),
        None,
        &mut Vec::new(),
    );
    assert!(
        events.is_empty(),
        "prompt 回显不应产生 steer 事件: {events:?}"
    );
}

#[test]
fn ignores_assistant_role_message_start() {
    // Assistant content arrives via message_update, so the assistant
    // message_start must not be surfaced (it carries no steer).
    let events = normalize_pi_agent_event(
        &json!({
            "type": "message_start",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "" }],
                "timestamp": 0
            }
        }),
        None,
        &mut Vec::new(),
    );
    assert!(events.is_empty());
}

#[test]
fn ignores_message_end_for_steer() {
    // Only message_start is converted; message_end is a duplicate marker.
    let events = normalize_pi_agent_event(
        &json!({
            "type": "message_end",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "steer text" }],
                "timestamp": 0
            }
        }),
        None,
        &mut Vec::new(),
    );
    assert!(events.is_empty());
}

#[test]
fn applies_resolved_session_prompt_injection_before_prompt_is_sent() {
    let injection = crate::agent::ResolvedSessionPromptInjection {
        open_tag: "<jishu-runtime-context>".into(),
        close_tag: "</jishu-runtime-context>".into(),
        session_id_field: "session_id".into(),
        guidance: "直接使用该 session_id，不要扫描 session 文件。".into(),
    };

    let message = apply_resolved_session_prompt_injection(
        "用户原始消息".to_string(),
        "sid-real",
        Some(&injection),
    );

    assert!(message.starts_with("<jishu-runtime-context>"));
    assert!(message.contains("session_id: sid-real"));
    assert!(message.contains("直接使用该 session_id"));
    assert!(message.ends_with("用户原始消息"));
}

#[test]
fn converts_extension_ui_select_to_interaction_request() {
    let event = convert_extension_ui_request(&json!({
        "type": "extension_ui_request",
        "id": "req-uuid-1",
        "method": "select",
        "title": "请选择实现方案",
        "options": ["方案A", "方案B", "方案C"]
    }))
    .expect("select should convert");

    match event {
        NormalizedEvent::InteractionRequest {
            request_id,
            prompt,
            options,
            allow_multiple,
            allow_custom_text,
            required,
            transport,
            origin,
            delivery_hint,
            correlation,
        } => {
            assert_eq!(request_id, "req-uuid-1");
            assert_eq!(prompt, "请选择实现方案");
            assert_eq!(options.len(), 3);
            assert_eq!(options[0].label, "方案A");
            assert!(!allow_multiple);
            assert!(allow_custom_text);
            assert!(required);
            // Pi extension_ui is the production mid-turn baseline.
            assert_eq!(transport, InteractionTransport::PiRpc);
            assert_eq!(origin, InteractionOrigin::ExtensionUi);
            assert_eq!(delivery_hint, InteractionDeliveryHint::MidTurn);
            assert!(correlation.is_none());
        }
        _ => panic!("expected InteractionRequest"),
    }
}

#[test]
fn converts_extension_ui_multi_select_to_interaction_request() {
    let event = convert_extension_ui_request(&json!({
        "type": "extension_ui_request",
        "id": "req-multi-1",
        "method": "multiSelect",
        "title": "选择功能",
        "options": ["登录", "注册"]
    }))
    .expect("multiSelect should convert");

    match event {
        NormalizedEvent::InteractionRequest {
            request_id,
            options,
            allow_multiple,
            ..
        } => {
            assert_eq!(request_id, "req-multi-1");
            assert_eq!(options.len(), 2);
            assert!(allow_multiple);
        }
        _ => panic!("expected InteractionRequest"),
    }
}

#[test]
fn converts_extension_ui_input_to_interaction_request() {
    let event = convert_extension_ui_request(&json!({
        "type": "extension_ui_request",
        "id": "req-uuid-2",
        "method": "input",
        "title": "补充说明",
        "placeholder": "可选"
    }))
    .expect("input should convert");

    match event {
        NormalizedEvent::InteractionRequest {
            request_id,
            prompt,
            options,
            allow_custom_text,
            ..
        } => {
            assert_eq!(request_id, "req-uuid-2");
            assert_eq!(prompt, "补充说明");
            assert!(options.is_empty());
            assert!(allow_custom_text);
        }
        _ => panic!("expected InteractionRequest"),
    }
}

#[test]
fn ignores_fire_and_forget_extension_ui_requests() {
    assert!(convert_extension_ui_request(&json!({
        "type": "extension_ui_request",
        "id": "x",
        "method": "notify",
        "message": "hello"
    }))
    .is_none());
    assert!(convert_extension_ui_request(&json!({
        "type": "extension_ui_request",
        "id": "y",
        "method": "setStatus",
        "statusKey": "progress",
        "statusText": "50%"
    }))
    .is_none());
}

// ---- v0.9.6 需求6 F2：回合分级看门狗纯函数 ----

#[test]
fn watchdog_windows_delivery_scope() {
    use super::*;
    // v0.9.6 需求9 哲学修正后看门狗只剩投递确认两相位：紧凑窗 < 宽窗。
    let ar = turn_watchdog_window(WatchdogPhase::AwaitResponse);
    let ats = turn_watchdog_window(WatchdogPhase::AwaitTurnStart);
    assert!(
        ats < ar,
        "AwaitTurnStart 紧凑窗 < AwaitResponse 宽窗: {ats:?} < {ar:?}"
    );
}

#[test]
fn watchdog_disarms_on_turn_events() {
    use super::*;
    // v0.9.6 需求9 哲学裁决：回合事件=投递成功铁证 → 解除看门狗（返回
    // None），此后无条件信任 pi；非回合事件也不武装（None）。
    for ev in [
        "agent_start",
        "turn_start",
        "message_start",
        "message_end",
        "tool_execution_start",
        "tool_execution_end",
        "agent_end",
        "agent_settled",
        "compaction_start",
        "extension_ui_request",
        "thinking_level_changed",
    ] {
        assert_eq!(
            watchdog_phase_on_event(WatchdogPhase::AwaitTurnStart, ev),
            None,
            "事件 {ev} 应解除看门狗（信任 pi）"
        );
    }
}

/// v0.9.8 需求7 补充轮 UC-10：空闲回收判定——引擎在压缩时不回收（压缩期间
/// 引擎静默、状态是 Idle，但不是空闲）。
#[test]
fn idle_reap_skipped_while_compacting() {
    use super::*;
    let now = tokio::time::Instant::now();
    assert!(
        idle_reap_due(true, false, now, now),
        "空闲且空闲期限到期 → 回收"
    );
    assert!(
        !idle_reap_due(true, true, now, now),
        "空闲期限到期但引擎在压缩 → 不回收"
    );
    assert!(
        !idle_reap_due(false, false, now, now),
        "回合进行中 → 不回收"
    );
    assert!(
        !idle_reap_due(true, false, now + std::time::Duration::from_secs(1), now),
        "到期的不是空闲期限 → 不回收"
    );
}

/// v0.9.8 需求1（生产事故回归，用例 A1/A2）：陈旧交互提交被拒不退出
/// 连接循环 + 并行交互各自登记可答。假 pi（node -e）收到 prompt 后发出
/// 两个 extension_ui_request；测试先提交陈旧 id（应报错且循环存活——
/// 此前该分支误用 return Ok(()) 杀掉整个会话进程），再依次应答两个真实
/// id（均应成功——此前单槽只记最后一个 id，先到的卡必被误判陈旧），
/// 最后核对假 pi 真正收到了两条 extension_ui_response 回写。
#[tokio::test]
async fn stale_reject_keeps_loop_alive_and_concurrent_interactions_answerable() {
    let node_ok = tokio::process::Command::new("node")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    if !node_ok {
        eprintln!("node 不可用，跳过假 pi 循环级回归测试");
        return;
    }

    let out_path = std::env::temp_dir().join(format!(
        "fake_pi_out_{}_{}.jsonl",
        std::process::id(),
        "stale_reject"
    ));
    let _ = std::fs::remove_file(&out_path);
    let out_str = out_path.to_string_lossy().to_string();

    // 注意：脚本内禁用反斜杠转义（\n 等）——构建环境的 shell 会吃转义，
    // 写入文件变成真换行破坏 JS 语法；换行统一用 String.fromCharCode(10)。
    let script = r#"
const fs = require('fs');
const NL = String.fromCharCode(10);
const rl = require('readline').createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + NL);
const out = process.env.FAKE_PI_OUT;
const log = (s) => fs.appendFileSync(out, s + NL);
rl.on('line', (line) => {
  log('RECV ' + line);
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'get_state') {
send({ type: 'response', command: 'get_state', success: true, data: { sessionId: 'fake-session-1', model: { contextWindow: 200000 }, thinkingLevel: 'high', autoCompactionEnabled: true } });
  } else if (msg.type === 'prompt') {
send({ type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
send({ type: 'agent_start' });
send({ type: 'extension_ui_request', id: 'id-1', method: 'select', title: 'Q1', options: ['A', 'B'] });
send({ type: 'extension_ui_request', id: 'id-2', method: 'select', title: 'Q2', options: ['C', 'D'] });
  } else if (msg.type === 'extension_ui_response') {
log(JSON.stringify(msg));
  }
});
"#;

    let child = tokio::process::Command::new("node")
        .arg("-e")
        .arg(script)
        .env("FAKE_PI_OUT", &out_str)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("spawn fake pi");

    let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen_clone = seen.clone();
    let emit: crate::acp_runtime::AcpEventEmit = std::sync::Arc::new(
        move |events: &[crate::agent::normalized::NormalizedEvent], _sid: &str| {
            let mut guard = seen_clone.lock().unwrap();
            for event in events {
                if let crate::agent::normalized::NormalizedEvent::InteractionRequest {
                    request_id,
                    ..
                } = event
                {
                    guard.push(request_id.clone());
                }
            }
        },
    );

    let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let finished_clone = finished.clone();
    let control = super::spawn_pi_rpc_session_inner(
        emit,
        super::noop_dev_log_emitter(),
        "jishu-self".to_string(),
        "pending-stale-test".to_string(),
        child,
        Some("hello".to_string().into()),
        None,
        None,
        None,
        move || finished_clone.store(true, std::sync::atomic::Ordering::SeqCst),
        |_sid: &str| {},
    );

    // 等两个交互请求到达（10s 上限）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if seen.lock().unwrap().len() >= 2 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "假 pi 未发出两个交互请求；OUT={:?}",
            std::fs::read_to_string(&out_path).unwrap_or_default()
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // 陈旧 id：报错但循环必须存活（BUG-1 回归）
    let stale = control
        .respond_to_input("stale-id".to_string(), "x".to_string())
        .await;
    assert!(stale.is_err(), "陈旧 id 应被拒绝");
    assert!(
        !finished.load(std::sync::atomic::Ordering::SeqCst),
        "拒绝陈旧提交不得退出连接循环"
    );

    // 两个真实 id 依次可答（BUG-2 回归：单槽只记最后一个，id-1 应被误判陈旧）
    control
        .respond_to_input("id-1".to_string(), "A".to_string())
        .await
        .expect("第一张卡应答成功");
    control
        .respond_to_input("id-2".to_string(), "C".to_string())
        .await
        .expect("第二张卡应答成功");

    // 假 pi 收到两条 extension_ui_response 回写（5s 上限）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let responses = loop {
        let content = std::fs::read_to_string(&out_path).unwrap_or_default();
        let count = content
            .lines()
            .filter(|l| l.contains("extension_ui_response"))
            .count();
        if count >= 2 {
            break content;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "假 pi 未收到两条回写：{content}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    assert!(
        responses.contains("\"id\":\"id-1\"") && responses.contains("\"id\":\"id-2\""),
        "两条回写应分别命中 id-1/id-2"
    );

    control.shutdown().await;
    let _ = std::fs::remove_file(&out_path);
    crate::pending_messages::drop_session("pending-stale-test");
}

/// v0.9.8 评审修复轮 R1-1（假引擎端到端）：带注入的消息从发送入口到
/// 引擎回报「用户消息已落盘」，账本清空、不留幽灵。
/// 修前：入口按用户原文记账，引擎侧按「原文 + 注入块」的文本去找这笔账
/// 销账——两段文本永不相等，原文账永远销不掉，重开会话即多出一条
/// 「未送达」。现在入口账带身份到引擎侧，落地时按身份改写。
#[tokio::test]
async fn entry_ledger_settles_by_identity_through_engine_persist_receipt() {
    let node_ok = tokio::process::Command::new("node")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    if !node_ok {
        eprintln!("node 不可用，跳过假 pi 账本回归测试");
        return;
    }
    let _guard = crate::agent::manifest::env_test_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    // 发送入口：按用户原文记账，拿到这笔账的身份。
    let entry_key = "pending-ledger-e2e";
    let entry = crate::pending_messages::record(
        entry_key,
        "jishu-self",
        "帮我看看这个报错 @[jishu CLI 工具]",
    )
    .expect("入口账身份");
    // 入口原文 ≠ 引擎侧实际发出的文本（追加工具说明块 + 会话注入）。
    let persisted = String::from(
        "<jishu-session>ledger-e2e</jishu-session>\n\n帮我看看这个报错 @[jishu CLI 工具]\n\n<jishu-tools>…</jishu-tools>",
    );

    // 注意：脚本内禁用反斜杠转义（同上）；pi 收到 prompt 即把它作为
    // 用户消息落盘并回报 message_end(role=user)。
    let script = r#"
const NL = String.fromCharCode(10);
const rl = require('readline').createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + NL);
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'get_state') {
send({ type: 'response', command: 'get_state', success: true, data: { sessionId: 'fake-ledger-session', model: { contextWindow: 200000 }, thinkingLevel: 'high', autoCompactionEnabled: true } });
  } else if (msg.type === 'prompt') {
send({ type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
send({ type: 'agent_start' });
send({ type: 'message_start', message: { role: 'user', content: [] } });
send({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: msg.message }] } });
send({ type: 'agent_end' });
  }
});
"#;
    let child = tokio::process::Command::new("node")
        .arg("-e")
        .arg(script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("spawn fake pi");
    let emit: crate::acp_runtime::AcpEventEmit = std::sync::Arc::new(|_events, _sid| {});
    let control = super::spawn_pi_rpc_session_inner(
        emit,
        super::noop_dev_log_emitter(),
        "jishu-self".to_string(),
        entry_key.to_string(),
        child,
        Some(PromptPayload {
            message: persisted.clone(),
            pending_entries: vec![entry],
            user_text: None,
        }),
        None,
        None,
        None,
        || {},
        |_sid: &str| {},
    );

    // 引擎回报落盘 → 账本清空（10s 上限；修前此处恒剩一条原文幽灵）。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let unsent = [
            crate::pending_messages::dedupe_against("fake-ledger-session", &[]),
            crate::pending_messages::dedupe_against(entry_key, &[]),
        ]
        .concat();
        if unsent.is_empty() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "引擎已回报落盘，账本仍有未送达残留：{unsent:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    control.shutdown().await;
    crate::pending_messages::drop_session("fake-ledger-session");
    crate::pending_messages::drop_session(entry_key);
}

async fn node_available() -> bool {
    tokio::process::Command::new("node")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn wait_for_event(
    seen: &std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    want: &str,
    what: &str,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if seen.lock().unwrap().iter().any(|s| s == want) {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "hub 未收到 {what}：{:?}",
            seen.lock().unwrap().clone()
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// v0.9.8 需求7 补充轮 UC-8/UC-9：假引擎的压缩流程（node -e）。
/// - mode = "ok"：收到 compact → 发 compaction_start → 发成功的
///   compaction_end → 回成功响应；
/// - mode = "fail"：发带 errorMessage 的 compaction_end → 回错误响应；
/// - mode = "cancel"：发 compaction_start 后等 hub 的 abort → 发
///   compaction_end(aborted) → 回错误响应。
///
/// cancel = true：hub 收到 compaction_start 后发停止命令。
/// 返回（compact 的结果、假引擎收到的全部命令行、hub 归一化后的事件）。
async fn run_fake_compaction(
    mode: &'static str,
    cancel: bool,
) -> (
    Result<serde_json::Value, String>,
    String,
    std::sync::Arc<std::sync::Mutex<Vec<String>>>,
) {
    let out_path = std::env::temp_dir().join(format!(
        "fake_pi_out_{}_compact_{mode}.jsonl",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&out_path);
    // 注意：脚本内禁用反斜杠转义（同上）。
    let script = r#"
const NL = String.fromCharCode(10);
const fs = require('fs');
const rl = require('readline').createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + NL);
const out = process.env.FAKE_PI_OUT;
const mode = process.env.FAKE_PI_MODE;
const log = (s) => fs.appendFileSync(out, s + NL);
let compactId = null;
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'get_state') {
send({ type: 'response', command: 'get_state', success: true, data: { sessionId: 'fake-compact-session', model: { contextWindow: 200000 }, thinkingLevel: 'high', autoCompactionEnabled: true } });
  } else if (msg.type === 'compact') {
log('RECV ' + line);
compactId = msg.id;
if (mode === 'fail') {
  send({ type: 'compaction_end', reason: 'manual', result: null, aborted: false, willRetry: false, errorMessage: 'Compaction failed: provider 500' });
  send({ type: 'response', id: msg.id, command: 'compact', success: false, error: 'Compaction failed: provider 500' });
  return;
}
send({ type: 'compaction_start', reason: 'manual' });
if (mode === 'ok') {
  send({ type: 'compaction_end', reason: 'manual', result: { summary: 's', firstKeptEntryId: 'k', tokensBefore: 10, estimatedTokensAfter: 5 }, aborted: false, willRetry: false });
  send({ type: 'response', id: msg.id, command: 'compact', success: true, data: { summary: 's', firstKeptEntryId: 'k', tokensBefore: 10, estimatedTokensAfter: 5 } });
}
  } else if (msg.type === 'abort') {
log('RECV ' + line);
if (mode === 'cancel') {
  send({ type: 'compaction_end', reason: 'manual', result: null, aborted: true, willRetry: false });
  send({ type: 'response', id: compactId, command: 'compact', success: false, error: 'Compaction cancelled' });
}
  }
});
"#;
    let child = tokio::process::Command::new("node")
        .arg("-e")
        .arg(script)
        .env("FAKE_PI_OUT", out_path.to_string_lossy().to_string())
        .env("FAKE_PI_MODE", mode)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("spawn fake pi");

    let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen_clone = seen.clone();
    let emit: crate::acp_runtime::AcpEventEmit = std::sync::Arc::new(
        move |events: &[crate::agent::normalized::NormalizedEvent], _sid: &str| {
            let mut guard = seen_clone.lock().unwrap();
            for event in events {
                let tag = match event {
                    crate::agent::normalized::NormalizedEvent::PhaseDivider { title, .. } => {
                        format!("divider:{title}")
                    }
                    crate::agent::normalized::NormalizedEvent::CompactionStatus {
                        active, ..
                    } => format!("status:{active}"),
                    crate::agent::normalized::NormalizedEvent::Error { message, .. } => {
                        format!("error:{message}")
                    }
                    _ => continue,
                };
                guard.push(tag);
            }
        },
    );
    let control = super::spawn_pi_rpc_session_inner(
        emit,
        super::noop_dev_log_emitter(),
        "jishu-self".to_string(),
        format!("compact-{mode}-test"),
        child,
        None,
        None,
        None,
        None,
        || {},
        |_sid: &str| {},
    );
    let control_for_compact = control.clone();
    let compact_task = tokio::spawn(async move { control_for_compact.compact(None).await });

    if cancel {
        wait_for_event(&seen, "status:true", "compaction_start").await;
        control.send_cancel().await;
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), compact_task)
        .await
        .expect("compact 未在 10 秒内返回（停止没有送达引擎时即卡在这里）")
        .expect("compact 任务异常退出");
    let engine_in = std::fs::read_to_string(&out_path).unwrap_or_default();
    control.shutdown().await;
    let _ = std::fs::remove_file(&out_path);
    (result, engine_in, seen)
}

/// v0.9.8 需求7 补充轮 UC-8 + UC-9（取消）：纯压缩期间（hub 状态是 Idle）
/// 点停止 → hub 把 abort 送给引擎；引擎回 compaction_end(aborted) 后，compact
/// 以「已取消」正常返回。
/// 修前：Idle 分支丢弃停止命令——引擎收不到 abort，compact 永不返回。
#[tokio::test]
async fn cancel_during_compaction_reaches_engine_and_settles_as_cancelled() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 压缩回归测试");
        return;
    }
    let (result, engine_in, seen) = run_fake_compaction("cancel", true).await;
    assert!(
        engine_in
            .lines()
            .any(|l| l.starts_with("RECV ") && l.contains(r#""type":"abort""#)),
        "引擎应收到停止命令：{engine_in}"
    );
    let result = result.expect("用户取消的压缩不是失败");
    assert_eq!(result, serde_json::json!({ "cancelled": true }));
    let seen = seen.lock().unwrap().clone();
    assert!(
        seen.contains(&"divider:上下文压缩已取消".to_string()),
        "{seen:?}"
    );
}

/// v0.9.8 需求7 补充轮 UC-9（成功 / 失败）：结果口径不变——成功返回引擎的
/// 结果对象，失败返回错误消息（此时引擎的 compaction_end 未被中止）。
#[tokio::test]
async fn compact_success_and_failure_keep_their_outcomes() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 压缩回归测试");
        return;
    }
    let (result, _, seen) = run_fake_compaction("ok", false).await;
    assert_eq!(result.expect("成功")["summary"], serde_json::json!("s"));
    let seen = seen.lock().unwrap().clone();
    assert!(
        seen.contains(&"divider:上下文已压缩".to_string()),
        "{seen:?}"
    );

    let (result, _, seen) = run_fake_compaction("fail", false).await;
    let err = result.expect_err("失败的压缩返回错误");
    assert!(err.contains("provider 500"), "{err}");
    let seen = seen.lock().unwrap().clone();
    assert!(
        seen.contains(&"divider:上下文压缩失败".to_string()),
        "{seen:?}"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// v0.9.8 评审修复轮 R2：扩展命令（C1）/ 账本销账（C2）/ 错误前缀（C5）/
// 压缩停止的收尾期限 / 重复压缩 / 引擎错误中文化
// ═══════════════════════════════════════════════════════════════════════════

// ── 纯函数 ──

/// C1：`TurnEndReason::Handled` 的线上值是前端契约（`reason === "Handled"`）。
#[test]
fn turn_end_reason_handled_wire_value() {
    let wire = serde_json::to_value(TurnEndReason::Handled).unwrap();
    assert_eq!(wire, json!("Handled"));
    let back: TurnEndReason = serde_json::from_value(wire).unwrap();
    assert_eq!(back, TurnEndReason::Handled);
}

/// C1：扩展命令名按「首个空白之前」取，与引擎的命令识别同口径。
#[test]
fn extension_command_name_follows_engine_parsing() {
    let name = super::extension_command_name;
    assert_eq!(name("/todos"), Some("todos"));
    assert_eq!(name("/todos a b"), Some("todos"));
    // 引擎只按空格切名字：换行不算分隔，这一段整体是「名字」，对不上任何命令。
    assert_eq!(name("/todos\n正文"), Some("todos\n正文"));
    assert_eq!(name("/"), None);
    assert_eq!(name("/ todos"), None);
    assert_eq!(name("todos"), None);
    assert_eq!(name(""), None);
}

/// C1：只认 `source == "extension"`；失败响应、别的命令的响应一律不采用。
#[test]
fn extension_command_names_from_get_commands_response() {
    let names = super::extension_command_names;
    let response = json!({
        "type": "response",
        "id": "hub-commands-0",
        "command": "get_commands",
        "success": true,
        "data": {
            "commands": [
                { "name": "todos", "source": "extension" },
                { "name": "skill:jishu-cli-guide", "source": "skill" },
                { "name": "review", "source": "prompt" },
                { "name": "", "source": "extension" }
            ]
        }
    });
    let only: std::collections::HashSet<String> = ["todos".to_string()].into_iter().collect();
    assert_eq!(names(&response), Some(only));
    assert!(names(
        &json!({ "type": "response", "command": "get_commands", "success": false, "error": "x" })
    )
    .is_none());
    assert!(
        names(&json!({ "type": "response", "command": "get_state", "success": true })).is_none()
    );
    assert!(names(&json!({ "type": "agent_start" })).is_none());
}

/// C1：请求号在 hub → 引擎 → hub 一路上不变、可辨。
#[test]
fn request_ids_round_trip_through_engine_echo() {
    let mut ids = RequestIds::default();
    let prompt_seq = ids.next();
    let compact_seq = ids.next();
    assert_ne!(prompt_seq, compact_seq);
    let echoed = json!({ "type": "response", "id": request_id(REQUEST_ID_PROMPT, prompt_seq) });
    let response_id = echoed.get("id").and_then(|v| v.as_str());
    assert_eq!(
        request_seq(response_id, REQUEST_ID_PROMPT),
        Some(prompt_seq)
    );
    // 前缀不符 / 没带 id：不是 hub 的这类请求。
    assert_eq!(request_seq(response_id, REQUEST_ID_COMPACT), None);
    assert_eq!(request_seq(None, REQUEST_ID_PROMPT), None);
}

/// 压缩停止的收尾期限：只有「武装过且已到期」才成立。
#[test]
fn compaction_settle_due_only_when_armed_and_reached() {
    let now = tokio::time::Instant::now();
    assert!(!super::compaction_settle_due(None, now), "没点过停止不武装");
    assert!(!super::compaction_settle_due(
        Some(now + Duration::from_secs(1)),
        now
    ));
    assert!(super::compaction_settle_due(Some(now), now));
}

/// 期限到了发给界面的事件，必须与「引擎响应停止」（compaction_end 带
/// aborted）归一化出来的一对事件**整体相等**：终态分隔线在前、压缩结束在
/// 后、没有错误事件。前端按分隔线标题的字面量认压缩终态——两边哪一天字面
/// 量或顺序对不上，这里直接变红。
#[test]
fn compaction_settle_events_match_engine_cancel_exactly() {
    let engine_cancel = normalize_pi_agent_event(
        &json!({
            "type": "compaction_end",
            "reason": "manual",
            "result": null,
            "aborted": true
        }),
        None,
        &mut Vec::new(),
    );
    assert_eq!(
        super::compaction_settle_events(),
        engine_cancel,
        "hub 合成的收场事件必须与引擎真实取消同形同序"
    );
}

/// 评审修复轮 R3（域 3 P2-22 / P2-24）：「压缩进行中再发起」的提示，后端与
/// 前端词典 `sessions.compactAlreadyRunning` 逐字相同——两边各写各的时，同一
/// 个场景界面出现过两种说法。
#[test]
fn duplicate_compact_hint_matches_the_frontend_dictionary() {
    let dictionary: serde_json::Value =
        serde_json::from_str(include_str!("../../../src/i18n/zh.json"))
            .expect("前端中文词典应是合法 JSON");
    let frontend = dictionary
        .pointer("/sessions/compactAlreadyRunning")
        .and_then(|value| value.as_str())
        .expect("词典里应有 sessions.compactAlreadyRunning");
    assert_eq!(DUPLICATE_COMPACT_HINT, frontend);
}

/// 引擎的已知英文错误换成中文上屏；压缩失败保留模型服务给的原因；不认识
/// 的原话前面加中文引导。
#[test]
fn known_engine_errors_map_to_chinese() {
    let zh = engine_error_message;
    let cases = [
        (
            "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
            "上下文正在压缩",
        ),
        (
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
            "智能体还在处理上一条消息",
        ),
        ("No model selected.\n\nRun /login.\n\nThen use /model to select a model.", "还没有选择模型"),
        ("No API key found for zhipu.\n\nRun /login first.", "还没有配置访问密钥"),
        (
            "Authentication failed for \"zhipu\". Credentials may have expired or network is unavailable.",
            "模型登录已失效",
        ),
        ("Extension failed, blocking execution: boom", "扩展拦截了这条消息"),
        ("Already compacted", "上下文刚刚压缩过"),
        ("Nothing to compact (session too small)", "会话内容还不多"),
    ];
    for (raw, expected) in cases {
        let message = zh(raw);
        assert!(message.contains(expected), "{raw:?} → {message}");
        // 已知错误：英文原话不上屏（取原话首个单词抽查）。
        let first_word = raw.split_whitespace().next().unwrap();
        assert!(!message.contains(first_word), "{raw:?} → {message}");
    }
    assert_eq!(
        zh("Compaction failed: provider 500"),
        "上下文压缩失败：provider 500"
    );
    assert_eq!(
        zh("something odd happened"),
        "智能体返回了错误：something odd happened"
    );
}

// ── 假引擎端到端 ──

/// 统一的假引擎，按环境变量切换行为：
/// - `FAKE_PI_MODE`：`turn`（默认：收到 prompt 起一个完整回合、落盘用户消息）/
///   `hold`（首条消息的回合启动并落盘后停住，等放行；之后的消息照常）/ `prehold`（首条消息只回 started、
///   不落盘，等 abort 收口；之后恢复 turn）/ `reject`（拒收 prompt）/
///   `compact-hang`（压缩开始后对 abort 不收尾）/ `compact-slow`（压缩开始后等
///   放行才结束）；
/// - `FAKE_PI_EXT`：扩展命令的回执——`handled`（默认）/ `fail`（回失败响应）；
/// - `FAKE_PI_CMDS`：本引擎注册的扩展命令名（逗号分隔）；
/// - `FAKE_PI_SESSION`：get_state 报告的会话号。
///
/// 技能命令 `/skill:x` 落盘的是展开后的另一段文字（真实引擎的行为）。放行
/// 信号借用 `set_thinking_level`（hub 原样转发给引擎）。注意：脚本内不写
/// 反斜杠转义（同上方用例的注意事项）。
const FAKE_PI_SCRIPT: &str = r#"
const NL = String.fromCharCode(10);
const fs = require('fs');
const rl = require('readline').createInterface({ input: process.stdin });
// FAKE_PI_NO_ECHO=1：响应不回带请求号（模拟不回带 id 的引擎）。
const noEcho = process.env.FAKE_PI_NO_ECHO === '1';
const send = (o) => {
  if (noEcho && o.type === 'response') delete o.id;
  process.stdout.write(JSON.stringify(o) + NL);
};
const out = process.env.FAKE_PI_OUT;
const log = (s) => { if (out) fs.appendFileSync(out, s + NL); };
const mode = process.env.FAKE_PI_MODE || 'turn';
const ext = process.env.FAKE_PI_EXT || 'handled';
const cmds = (process.env.FAKE_PI_CMDS || '').split(',').filter(Boolean);
// get_commands 的回答方式：ok（默认）/ fail（回失败）/ late-line（回答前先发一条别的事件行）。
const cmdsMode = process.env.FAKE_PI_CMDS_MODE || 'ok';
const session = process.env.FAKE_PI_SESSION || 'fake-session';
let firstPrompt = true;
let held = false;
let compactId = null;
let gateStep = 0;
let gatedPrompt = null;
let extHeld = null;
const persistUser = (m) => {
  const text = m.message.startsWith('/skill:') ? 'EXPANDED SKILL BODY' : m.message;
  send({ type: 'message_start', message: { role: 'user', content: [] } });
  send({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } });
  log('PERSIST ' + text);
};
const settle = (aborted) => {
  send({ type: 'agent_end' });
  send({ type: 'agent_settled', aborted: aborted });
};
const turn = (m) => {
  send({ type: 'response', id: m.id, command: 'prompt', success: true, data: { disposition: 'started' } });
  send({ type: 'agent_start' });
  log('SENT agent_start');
  persistUser(m);
  settle(false);
};
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  log('RECV ' + line);
  if (m.type === 'get_state') {
    send({ type: 'response', id: m.id, command: 'get_state', success: true, data: { sessionId: session, model: { contextWindow: 200000 }, thinkingLevel: 'high', autoCompactionEnabled: true } });
  } else if (m.type === 'get_commands') {
    if (cmdsMode === 'late-line') {
      send({ type: 'message_start', message: { role: 'custom', customType: 'jishu-conductor:phase-enter:execute', content: '' } });
    }
    if (cmdsMode === 'fail') {
      send({ type: 'response', id: m.id, command: 'get_commands', success: false, error: 'Unknown command: get_commands' });
      return;
    }
    const commands = cmds.map((n) => ({ name: n, source: 'extension' })).concat([{ name: 'skill:x', source: 'skill' }, { name: 'review', source: 'prompt' }]);
    send({ type: 'response', id: m.id, command: 'get_commands', success: true, data: { commands: commands } });
  } else if (m.type === 'prompt') {
    const rest = m.message.slice(1);
    let i = 0;
    while (i < rest.length && rest.charAt(i) !== ' ' && rest.charAt(i) !== NL) i += 1;
    const isExt = m.message.startsWith('/') && cmds.includes(rest.slice(0, i));
    if (isExt && ext === 'handled') {
      send({ type: 'response', id: m.id, command: 'prompt', success: true, data: { disposition: 'handled' } });
      return;
    }
    if (isExt && ext === 'handled-late') {
      // 「已处理」压着不回，等放行（set_thinking_level）再回。
      extHeld = m;
      log('EXT_HELD ' + m.message);
      return;
    }
    if (isExt && ext === 'fail') {
      send({ type: 'response', id: m.id, command: 'prompt', success: false, error: 'command handler crashed' });
      return;
    }
    if (mode === 'reject') {
      send({ type: 'response', id: m.id, command: 'prompt', success: false, error: 'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.' });
      return;
    }
    if (mode === 'hold' && !held) {
      held = true;
      send({ type: 'response', id: m.id, command: 'prompt', success: true, data: { disposition: 'started' } });
      send({ type: 'agent_start' });
      log('SENT agent_start');
      persistUser(m);
      return;
    }
    if (mode === 'gated' && gateStep === 0) {
      // 首条消息分两步放行：第一次放行 -> 回合并启并落盘；第二次放行 -> 收口。
      gateStep = 1;
      gatedPrompt = m;
      send({ type: 'response', id: m.id, command: 'prompt', success: true, data: { disposition: 'started' } });
      log('GATED');
      return;
    }
    if (mode === 'prehold' && firstPrompt) {
      firstPrompt = false;
      send({ type: 'response', id: m.id, command: 'prompt', success: true, data: { disposition: 'started' } });
      return;
    }
    turn(m);
  } else if (m.type === 'compact') {
    compactId = m.id;
    if (mode === 'compact-hang' || mode === 'compact-slow' || mode === 'compact-cancel-ok') {
      send({ type: 'compaction_start', reason: 'manual' });
      return;
    }
    send({ type: 'compaction_end', reason: 'manual', result: { summary: 's' }, aborted: false });
    send({ type: 'response', id: m.id, command: 'compact', success: true, data: { summary: 'done' } });
  } else if (m.type === 'abort') {
    if (mode === 'prehold') settle(true);
    if (mode === 'compact-cancel-ok') {
      send({ type: 'compaction_end', reason: 'manual', result: null, aborted: true });
      send({ type: 'response', id: compactId, command: 'compact', success: false, error: 'Compaction cancelled' });
    }
  } else if (m.type === 'set_thinking_level') {
    if (mode === 'hold') settle(false);
    if (mode === 'gated' && gateStep === 1) {
      gateStep = 2;
      send({ type: 'agent_start' });
      log('SENT agent_start');
      persistUser(gatedPrompt);
      return;
    }
    if (mode === 'gated' && gateStep === 2) {
      gateStep = 3;
      settle(false);
      return;
    }
    if (extHeld) {
      const waiting = extHeld;
      extHeld = null;
      send({ type: 'response', id: waiting.id, command: 'prompt', success: true, data: { disposition: 'handled' } });
      log('EXT_RELEASED');
      return;
    }
    if (mode === 'compact-slow') {
      send({ type: 'compaction_end', reason: 'manual', result: { summary: 's' }, aborted: false });
      send({ type: 'response', id: 'hub-compact-99', command: 'compact', success: false, error: 'response with a request id hub never sent' });
      send({ type: 'response', id: compactId, command: 'compact', success: true, data: { summary: 'done' } });
    }
  }
});
"#;

const FAKE_PI_WAIT: Duration = Duration::from_secs(10);

/// 一次假引擎会话：控制句柄 + hub 归一化后的事件 + 引擎收发的流水。
struct FakePi {
    control: crate::acp_runtime::AcpControl,
    seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    out_path: std::path::PathBuf,
    finished: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl FakePi {
    async fn spawn(
        label: &str,
        session: &str,
        mode: &str,
        first: Option<PromptPayload>,
        extra_env: &[(&str, &str)],
    ) -> Self {
        Self::spawn_with_hook(label, session, mode, first, extra_env, None).await
    }

    /// `on_session_resolved`：连接循环的会话解析回调（早于首条 prompt 写出），
    /// 调用时带上引擎流水的路径——用例靠往流水里写标记来核对先后。
    async fn spawn_with_hook(
        label: &str,
        session: &str,
        mode: &str,
        first: Option<PromptPayload>,
        extra_env: &[(&str, &str)],
        on_session_resolved: Option<
            std::sync::Arc<dyn Fn(&str, &std::path::Path) + Send + Sync + 'static>,
        >,
    ) -> Self {
        let out_path = std::env::temp_dir().join(format!(
            "fake_pi_out_{}_r2_{label}.jsonl",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&out_path);
        let mut command = tokio::process::Command::new("node");
        command
            .arg("-e")
            .arg(FAKE_PI_SCRIPT)
            .env("FAKE_PI_OUT", out_path.to_string_lossy().to_string())
            .env("FAKE_PI_MODE", mode)
            .env("FAKE_PI_SESSION", session);
        for (key, value) in extra_env {
            command.env(key, value);
        }
        let child = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn fake pi");

        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let seen_clone = seen.clone();
        let emit: crate::acp_runtime::AcpEventEmit =
            std::sync::Arc::new(move |events: &[NormalizedEvent], _sid: &str| {
                let mut guard = seen_clone.lock().unwrap();
                for event in events {
                    let tag = match event {
                        NormalizedEvent::TurnComplete { reason, .. } => {
                            format!("turn_complete:{reason:?}")
                        }
                        NormalizedEvent::Error { message, .. } => format!("error:{message}"),
                        NormalizedEvent::CompactionStatus { active, .. } => {
                            format!("compaction_status:{active}")
                        }
                        NormalizedEvent::PhaseDivider { title, .. } => {
                            format!("divider:{title}")
                        }
                        NormalizedEvent::SteerQueueCleared { texts, .. } => {
                            format!("steer_queue_cleared:{}", texts.len())
                        }
                        _ => continue,
                    };
                    guard.push(tag);
                }
            });
        let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let finished_clone = finished.clone();
        let hook_path = out_path.clone();
        let control = super::spawn_pi_rpc_session_inner(
            emit,
            super::noop_dev_log_emitter(),
            "jishu-self".to_string(),
            session.to_string(),
            child,
            first,
            None,
            None,
            None,
            move || finished_clone.store(true, std::sync::atomic::Ordering::SeqCst),
            move |sid: &str| {
                if let Some(hook) = &on_session_resolved {
                    hook(sid, &hook_path);
                }
            },
        );
        Self {
            control,
            seen,
            out_path,
            finished,
        }
    }

    /// hub 发给界面的事件（按到达顺序的标签）。
    fn events(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }

    /// 引擎收到的命令行（每行一条 `RECV …`）。
    fn engine_log(&self) -> String {
        std::fs::read_to_string(&self.out_path).unwrap_or_default()
    }

    /// 等 hub 发出以 `prefix` 开头的事件。
    async fn wait_event(&self, prefix: &str) {
        let deadline = std::time::Instant::now() + FAKE_PI_WAIT;
        loop {
            if self.events().iter().any(|tag| tag.starts_with(prefix)) {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "hub 未发出 {prefix:?}；事件 {:?}；引擎流水 {:?}",
                self.events(),
                self.engine_log()
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// 引擎收到的全部 prompt 的 message（按到达顺序）。
    fn engine_prompts(&self) -> Vec<String> {
        self.engine_log()
            .lines()
            .filter_map(|line| line.strip_prefix("RECV "))
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter(|line| line.get("type").and_then(|v| v.as_str()) == Some("prompt"))
            .filter_map(|line| {
                line.get("message")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .collect()
    }

    /// 等引擎收到包含 `needle` 的命令行。
    async fn wait_engine(&self, needle: &str) {
        let deadline = std::time::Instant::now() + FAKE_PI_WAIT;
        loop {
            if self.engine_log().contains(needle) {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "引擎未收到含 {needle:?} 的命令；流水 {:?}",
                self.engine_log()
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// 等连接循环收尾（进程被杀或正常退出）。
    async fn wait_finished(&self) {
        let deadline = std::time::Instant::now() + FAKE_PI_WAIT;
        while !self.finished.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline, "连接循环未收尾");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    fn is_finished(&self) -> bool {
        self.finished.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Drop for FakePi {
    fn drop(&mut self) {
        let _ = self
            .control
            .tx
            .try_send(crate::acp_runtime::AcpCommand::Shutdown);
        let _ = std::fs::remove_file(&self.out_path);
    }
}

/// 账本里某会话仍未送达的账（`内容|状态`，按记账先后）。
fn ledger_states(session_id: &str) -> Vec<String> {
    crate::pending_messages::dedupe_against(session_id, &[])
        .iter()
        .map(|row| format!("{}|{}", row.content, row.state))
        .collect()
}

/// 测试期间缩短压缩收尾期限，离开作用域恢复默认。
struct SettleTimeoutGuard;

impl SettleTimeoutGuard {
    fn arm(millis: u64) -> Self {
        super::prompts::set_compaction_settle_timeout_for_test(millis);
        Self
    }
}

impl Drop for SettleTimeoutGuard {
    fn drop(&mut self) {
        super::prompts::set_compaction_settle_timeout_for_test(0);
    }
}

fn lock_env() -> std::sync::MutexGuard<'static, ()> {
    crate::agent::manifest::env_test_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// C1 + C2：引擎空闲时发一条扩展命令——引擎只回「已处理」、不起回合。
/// 修前：hub 把 handled 只当「解除看门狗」，状态机停在「回合进行中」，会话
/// 从此一直「处理中」（发版前评审 P0）。
#[tokio::test]
async fn extension_command_handled_completes_turn_and_settles_ledger() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 扩展命令回归测试");
        return;
    }
    let _guard = lock_env();
    let session = "r2-ext-handled";
    crate::pending_messages::drop_session(session);
    let pi = FakePi::spawn(
        "ext-handled",
        session,
        "turn",
        Some("hello".to_string().into()),
        &[("FAKE_PI_CMDS", "todos")],
    )
    .await;
    pi.wait_event("turn_complete:Complete").await;

    // 引擎空闲时发一条扩展命令：入口账是用户原文，组装后的文本带着注入块。
    let entry = crate::pending_messages::record(session, "jishu-self", "/todos").unwrap();
    let composed = "/todos\n\n<JISHU-TOOL-PLUGINS>\n## gh — GitHub CLI\n</JISHU-TOOL-PLUGINS>";
    pi.control
        .send_prompt(PromptPayload::composed(
            composed.to_string(),
            "/todos".to_string(),
            vec![entry],
        ))
        .await
        .unwrap();
    pi.wait_event("turn_complete:Handled").await;

    // 回到空闲：紧接着的普通消息走直发并正常收口。
    pi.control
        .send_prompt("second".to_string().into())
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + FAKE_PI_WAIT;
    while pi
        .events()
        .iter()
        .filter(|tag| *tag == "turn_complete:Complete")
        .count()
        < 2
    {
        assert!(
            std::time::Instant::now() < deadline,
            "Handled 之后的普通消息没有收口：{:?}",
            pi.events()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    // 全程恰好一条 Handled：这条命令的流被收走，别的回合不受影响。
    assert_eq!(
        pi.events(),
        vec![
            "turn_complete:Complete".to_string(),
            "turn_complete:Handled".to_string(),
            "turn_complete:Complete".to_string(),
        ]
    );
    assert!(!pi.is_finished(), "扩展命令不得导致连接循环退出");
    // 账：命令这一笔按身份销掉（引擎不落用户消息，没有落盘回执）；两条普通
    // 消息各被自己的落盘回执销掉。
    assert_eq!(ledger_states(session), Vec::<String>::new());
    // 引擎拿到的是用户原文——注入块没有跟着过去（TUI 同款）。
    assert_eq!(
        pi.engine_prompts(),
        vec![
            "hello".to_string(),
            "/todos".to_string(),
            "second".to_string()
        ]
    );
    crate::pending_messages::drop_session(session);
}

/// C1：回合进行中发扩展命令——立即转发，不动正在跑的回合。
#[tokio::test]
async fn extension_command_during_running_turn_is_forwarded_without_touching_turn() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 扩展命令回归测试");
        return;
    }
    let _guard = lock_env();
    let session = "r2-ext-running";
    crate::pending_messages::drop_session(session);
    let first = crate::pending_messages::record(session, "jishu-self", "hello").unwrap();
    let pi = FakePi::spawn(
        "ext-running",
        session,
        "hold",
        Some(PromptPayload::composed(
            "<jishu-session>x</jishu-session>\n\nhello".to_string(),
            "hello".to_string(),
            vec![first],
        )),
        &[("FAKE_PI_CMDS", "todos")],
    )
    .await;
    pi.wait_engine("SENT agent_start").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let entry = crate::pending_messages::record(session, "jishu-self", "/todos").unwrap();
    pi.control
        .send_prompt(PromptPayload::composed(
            "/todos\n\n<JISHU-MCP-HINT>\n提示\n</JISHU-MCP-HINT>".to_string(),
            "/todos".to_string(),
            vec![entry],
        ))
        .await
        .unwrap();
    // 引擎立即收到，而且是用户原文（不带注入后缀）。
    pi.wait_engine("\"message\":\"/todos\",").await;
    // 普通消息发的是组装后的文本；扩展命令发的是用户原文。
    assert_eq!(
        pi.engine_prompts(),
        vec![
            "<jishu-session>x</jishu-session>\n\nhello".to_string(),
            "/todos".to_string()
        ]
    );

    // 放行：正在跑的回合照常收口。
    pi.control
        .set_thinking_level("high".to_string())
        .await
        .unwrap();
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    // 没有为这条命令取消滞留回合，也没有多出的回合结束。
    let engine_log = pi.engine_log();
    assert!(
        !engine_log.contains("\"clear_queue\"") && !engine_log.contains("\"abort\""),
        "扩展命令不得触发取消正在跑的回合：{engine_log}"
    );
    assert_eq!(pi.events(), vec!["turn_complete:Complete".to_string()]);
    assert_eq!(ledger_states(session), Vec::<String>::new());
    crate::pending_messages::drop_session(session);
}

/// C1：停止善中期收到扩展命令——立即转发，不并进缓冲的消息。
#[tokio::test]
async fn extension_command_during_cancel_pending_is_not_merged_into_buffered_prompt() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 扩展命令回归测试");
        return;
    }
    // 评审修复轮 R3（P2-14）：持环境锁、开头清账——用例会读写共享的测试账本。
    let _guard = lock_env();
    let session = "r2-ext-cancel";
    crate::pending_messages::drop_session(session);
    let pi = FakePi::spawn(
        "ext-cancel",
        session,
        "hold",
        Some("hello".to_string().into()),
        &[("FAKE_PI_CMDS", "todos")],
    )
    .await;
    pi.wait_engine("SENT agent_start").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    pi.control.send_cancel().await;
    pi.wait_engine("\"abort\"").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    // 停止善中期先到一条普通消息（缓冲），再到一条扩展命令（立即执行）。
    pi.control
        .send_prompt("buffered message".to_string().into())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    pi.control
        .send_prompt("/todos".to_string().into())
        .await
        .unwrap();
    pi.wait_engine("\"message\":\"/todos\",").await;
    // 此刻缓冲的消息还没发出去。
    assert_eq!(
        pi.engine_prompts(),
        vec!["hello".to_string(), "/todos".to_string()]
    );

    pi.control
        .set_thinking_level("high".to_string())
        .await
        .unwrap();
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    // 取消收口一次（Aborted），缓冲的消息重发后收口一次（Complete）。
    assert_eq!(
        pi.events(),
        vec![
            "turn_complete:Aborted".to_string(),
            "turn_complete:Complete".to_string()
        ]
    );
    assert_eq!(
        pi.engine_prompts(),
        vec![
            "hello".to_string(),
            "/todos".to_string(),
            "buffered message".to_string()
        ],
        "扩展命令立即转发、不并进缓冲消息；缓冲的消息原样重发"
    );
    assert_eq!(
        ledger_states(session),
        Vec::<String>::new(),
        "三条都没带入口账：各自的账都销掉了，不在共享账本里留行"
    );
    crate::pending_messages::drop_session(session);
}

/// C1：以扩展命令作为会话首条消息拉起进程——握手后先取清单，首条按原文
/// 转发，handled 收口。
#[tokio::test]
async fn first_message_extension_command_classified_after_handshake() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 扩展命令回归测试");
        return;
    }
    let _guard = lock_env();
    let session = "r2-ext-first";
    crate::pending_messages::drop_session(session);
    let entry = crate::pending_messages::record(session, "jishu-self", "/todos").unwrap();
    let pi = FakePi::spawn(
        "ext-first",
        session,
        "turn",
        Some(PromptPayload::composed(
            "/todos\n\n<JISHU-EQUIP-CATALOG>\n目录\n</JISHU-EQUIP-CATALOG>".to_string(),
            "/todos".to_string(),
            vec![entry],
        )),
        &[("FAKE_PI_CMDS", "todos")],
    )
    .await;
    pi.wait_event("turn_complete:Handled").await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(pi.events(), vec!["turn_complete:Handled".to_string()]);
    assert_eq!(pi.engine_prompts(), vec!["/todos".to_string()]);
    assert_eq!(ledger_states(session), Vec::<String>::new());
    crate::pending_messages::drop_session(session);
}

/// C1：每回合结束刷新扩展命令清单；刷新响应不向界面发错误。
#[tokio::test]
async fn extension_command_list_refreshed_after_turn_end() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 扩展命令回归测试");
        return;
    }
    let pi = FakePi::spawn(
        "ext-refresh",
        "r2-ext-refresh",
        "turn",
        Some("hi".to_string().into()),
        &[],
    )
    .await;
    pi.wait_event("turn_complete:Complete").await;
    pi.wait_engine("hub-commands-2").await;
    let fetches = pi
        .engine_log()
        .lines()
        .filter(|line| line.contains("\"type\":\"get_commands\""))
        .count();
    assert!(fetches >= 2, "握手后一次 + 回合结束一次：{fetches}");
    assert!(
        !pi.events().iter().any(|tag| tag.starts_with("error:")),
        "{:?}",
        pi.events()
    );
}

/// C1：非扩展命令在回合进行中——维持「滞留回合取消重发」（既有行为不变）。
#[tokio::test]
async fn non_extension_prompt_during_prompting_keeps_stale_turn_resend() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 扩展命令回归测试");
        return;
    }
    let pi = FakePi::spawn(
        "ext-not-command",
        "r2-ext-not-command",
        "hold",
        Some("hello".to_string().into()),
        &[("FAKE_PI_CMDS", "todos")],
    )
    .await;
    pi.wait_engine("SENT agent_start").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    // 技能命令在引擎清单里是 source=skill，不是扩展命令：照常取消重发。
    pi.control
        .send_prompt("/skill:x".to_string().into())
        .await
        .unwrap();
    pi.wait_engine("\"abort\"").await;
    assert!(pi.engine_log().contains("\"clear_queue\""));
    pi.control
        .set_thinking_level("high".to_string())
        .await
        .unwrap();
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        pi.events(),
        vec![
            "turn_complete:Aborted".to_string(),
            "turn_complete:Complete".to_string()
        ]
    );
    assert_eq!(
        pi.engine_prompts(),
        vec!["hello".to_string(), "/skill:x".to_string()]
    );
}

/// C1 + C2：回合中转发的扩展命令失败——只报一条可恢复错误，不动正在跑的
/// 回合；这笔账确定未送达。
#[tokio::test]
async fn side_forwarded_command_failure_does_not_end_running_turn() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 扩展命令回归测试");
        return;
    }
    let _guard = lock_env();
    let session = "r2-ext-fail";
    crate::pending_messages::drop_session(session);
    let first = crate::pending_messages::record(session, "jishu-self", "hello").unwrap();
    let pi = FakePi::spawn(
        "ext-fail",
        session,
        "hold",
        Some(PromptPayload::composed(
            "hello".to_string(),
            "hello".to_string(),
            vec![first],
        )),
        &[("FAKE_PI_CMDS", "todos"), ("FAKE_PI_EXT", "fail")],
    )
    .await;
    pi.wait_engine("SENT agent_start").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let entry = crate::pending_messages::record(session, "jishu-self", "/todos").unwrap();
    pi.control
        .send_prompt(PromptPayload::composed(
            "/todos".to_string(),
            "/todos".to_string(),
            vec![entry],
        ))
        .await
        .unwrap();
    pi.wait_event("error:").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let events = pi.events();
    assert_eq!(
        events,
        vec!["error:智能体返回了错误：command handler crashed".to_string()],
        "失败的命令不得终结正在跑的回合"
    );

    pi.control
        .set_thinking_level("high".to_string())
        .await
        .unwrap();
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        ledger_states(session),
        vec!["/todos|unsent".to_string()],
        "失败的命令是未送达；正常落盘的那条已销"
    );
    crate::pending_messages::drop_session(session);
}

/// C2：技能命令展开后才落盘（落盘文本 ≠ 发送文本）——账按顺序销掉。
/// 修前：回执按文本相等认账，每发一条技能命令就多一条销不掉的「未送达」。
#[tokio::test]
async fn template_command_ledger_settles_on_expanded_persist_receipt() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 账本回归测试");
        return;
    }
    let _guard = lock_env();
    let session = "r2-ledger-template";
    crate::pending_messages::drop_session(session);
    let entry = crate::pending_messages::record(session, "jishu-self", "/skill:x").unwrap();
    let pi = FakePi::spawn(
        "ledger-template",
        session,
        "turn",
        Some(PromptPayload::composed(
            "/skill:x 帮我看看\n\n<JISHU-TOOL-PLUGINS>\n说明\n</JISHU-TOOL-PLUGINS>".to_string(),
            "/skill:x 帮我看看".to_string(),
            vec![entry],
        )),
        &[],
    )
    .await;
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        pi.engine_log().contains("PERSIST EXPANDED SKILL BODY"),
        "前置：假引擎落盘的是展开后的正文，与发给引擎的命令原文不同"
    );
    assert_eq!(ledger_states(session), Vec::<String>::new(), "账本应清空");
    crate::pending_messages::drop_session(session);
}

/// C2：回合没启动就被停止的那条消息，之后另一条正常送达——两条各归各。
/// 修前的隐患：没有回执的第一笔一直占着「等回执」的位置，第二条的回执把
/// 它销掉，真正送达的第二条反而留成「未送达」。
#[tokio::test]
async fn cancel_before_turn_start_leaves_no_ghost_for_next_message() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 账本回归测试");
        return;
    }
    let _guard = lock_env();
    let session = "r2-ledger-cancel";
    crate::pending_messages::drop_session(session);
    let first = crate::pending_messages::record(session, "jishu-self", "first message").unwrap();
    let pi = FakePi::spawn(
        "ledger-cancel",
        session,
        "prehold",
        Some(PromptPayload::composed(
            "first message".to_string(),
            "first message".to_string(),
            vec![first],
        )),
        &[],
    )
    .await;
    pi.wait_engine("\"type\":\"prompt\"").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    pi.control.send_cancel().await;
    pi.wait_event("turn_complete:Aborted").await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let second = crate::pending_messages::record(session, "jishu-self", "second message").unwrap();
    pi.control
        .send_prompt(PromptPayload::composed(
            "second message".to_string(),
            "second message".to_string(),
            vec![second],
        ))
        .await
        .unwrap();
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        ledger_states(session),
        vec!["first message|unsent".to_string()],
        "没处理的第一条是未送达；送达的第二条不留账"
    );
    crate::pending_messages::drop_session(session);
}

const GHOST: &str = "left behind by previous process";

/// 造一笔「上一代进程留下的落地账」：已经写给引擎、没等到回执进程就没了。
/// 它和确定未送达的不一样——上一代进程到底处理没处理，这一代无从得知。
fn stale_sent_from_previous_process(session: &str) {
    let entry = crate::pending_messages::record(session, "jishu-self", GHOST).unwrap();
    crate::pending_messages::confirm_entries(
        &[entry],
        session,
        "jishu-self",
        GHOST,
        crate::pending_messages::ledger_now_ms(),
    )
    .unwrap();
}

/// C2：上一代进程留下的落地账，在新连接**首条消息**发起之前落成终态。
/// 修前的隐患：它排在队头等回执，首条消息落盘的回执把它销掉，真正送达的
/// 这条反而留在「等回执」里。
#[tokio::test]
async fn stale_sent_from_previous_process_is_finalized_before_first_turn() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 账本回归测试");
        return;
    }
    let _guard = lock_env();
    let session = "r2-ledger-stale-first";
    crate::pending_messages::drop_session(session);
    stale_sent_from_previous_process(session);
    let fresh = crate::pending_messages::record(session, "jishu-self", "fresh message").unwrap();
    let pi = FakePi::spawn(
        "ledger-stale-first",
        session,
        "turn",
        Some(PromptPayload::composed(
            "fresh message".to_string(),
            "fresh message".to_string(),
            vec![fresh],
        )),
        &[],
    )
    .await;
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        ledger_states(session),
        vec![format!("{GHOST}|unsent")],
        "上一代的遗留账是未送达；这次送达的不留账"
    );
    crate::pending_messages::drop_session(session);
}

/// C2：同上，入口是连接建立之后才发的消息（会话一直开着、上一代的账还在）。
#[tokio::test]
async fn stale_sent_from_previous_process_is_finalized_before_later_turn() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 账本回归测试");
        return;
    }
    let _guard = lock_env();
    let session = "r2-ledger-stale-later";
    crate::pending_messages::drop_session(session);
    stale_sent_from_previous_process(session);
    let pi = FakePi::spawn("ledger-stale-later", session, "turn", None, &[]).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        ledger_states(session),
        vec![format!("{GHOST}|sent")],
        "前置：连接刚建立、还没发起回合时，遗留账仍在等回执"
    );

    let fresh = crate::pending_messages::record(session, "jishu-self", "fresh message").unwrap();
    pi.control
        .send_prompt(PromptPayload::composed(
            "fresh message".to_string(),
            "fresh message".to_string(),
            vec![fresh],
        ))
        .await
        .unwrap();
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        ledger_states(session),
        vec![format!("{GHOST}|unsent")],
        "上一代的遗留账是未送达；这次送达的不留账"
    );
    crate::pending_messages::drop_session(session);
}

/// 主控边界：上一代的落地账其实落了盘（引擎写了用户消息、hub 没等到回执就
/// 退出），而新回合赶在界面加载之前发起——发起前先按会话文件对账，这笔销
/// 掉，不落终态。
/// 修前的隐患：不看证据一律落终态，已送达的消息从此显示成「未送达」，而
/// 终态账不再参与加载时的判定。
#[tokio::test]
async fn delivered_row_whose_receipt_was_missed_is_settled_before_turn() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 账本回归测试");
        return;
    }
    let _guard = lock_env();
    // 会话文件里，这笔账之后落了一条用户消息（替身证据——测试不碰用户目录）。
    let _evidence = PersistedUserAtGuard::set(vec![crate::util::now_ms() + 60_000]);
    let session = "r2-ledger-evidence";
    crate::pending_messages::drop_session(session);
    stale_sent_from_previous_process(session);
    let fresh = crate::pending_messages::record(session, "jishu-self", "fresh message").unwrap();
    let pi = FakePi::spawn(
        "ledger-evidence",
        session,
        "turn",
        Some(PromptPayload::composed(
            "fresh message".to_string(),
            "fresh message".to_string(),
            vec![fresh],
        )),
        &[],
    )
    .await;
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        ledger_states(session),
        Vec::<String>::new(),
        "已落盘的旧账销掉、不落终态；这次送达的不留账"
    );
    crate::pending_messages::drop_session(session);
}

/// 主控边界（反向）：上一代的落地账确实没落盘——它之后会话文件里没有用户
/// 消息。界面加载后它仍是未送达；新回合发起时落终态，新消息的账被自己的
/// 回执销掉；新消息落盘之后再加载，它还是「未送达」——既没被新消息的回执
/// 错销，也没被加载判定错销。
#[tokio::test]
async fn undelivered_legacy_row_stays_unsent_across_later_turn_and_reload() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 账本回归测试");
        return;
    }
    let _guard = lock_env();
    let session = "r2-ledger-coexist";
    crate::pending_messages::drop_session(session);
    stale_sent_from_previous_process(session);
    // ① 界面加载：真实加载入口调的就是这一步对账；会话文件里没有它之后的
    //    用户消息 → 仍是未送达。
    assert_eq!(ledger_states(session), vec![format!("{GHOST}|sent")]);

    // ② 新连接里发下一条（替身证据是空的：之后还是没有用户消息落盘）。
    let fresh = crate::pending_messages::record(session, "jishu-self", "fresh message").unwrap();
    let pi = FakePi::spawn(
        "ledger-coexist",
        session,
        "turn",
        Some(PromptPayload::composed(
            "fresh message".to_string(),
            "fresh message".to_string(),
            vec![fresh],
        )),
        &[],
    )
    .await;
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        ledger_states(session),
        vec![format!("{GHOST}|unsent")],
        "确实没落盘的旧账落终态；新消息的账被自己的回执销掉"
    );

    // ③ 新消息已落盘，再加载一次：旧账是终态，不参与判定，仍是未送达。
    let unsent =
        crate::pending_messages::dedupe_against(session, &[crate::util::now_ms() + 60_000]);
    assert_eq!(
        unsent
            .iter()
            .map(|row| row.content.as_str())
            .collect::<Vec<_>>(),
        vec![GHOST]
    );
    assert_eq!(ledger_states(session), vec![format!("{GHOST}|unsent")]);
    crate::pending_messages::drop_session(session);
}

/// C5：陈旧交互提交的报错带机器可读前缀，其后保留原句。
#[tokio::test]
async fn stale_interaction_error_carries_machine_prefix() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 交互回归测试");
        return;
    }
    let pi = FakePi::spawn(
        "stale-prefix",
        "r2-stale-prefix",
        "turn",
        Some("hello".to_string().into()),
        &[],
    )
    .await;
    pi.wait_event("turn_complete:Complete").await;
    let err = pi
        .control
        .respond_to_input("no-such-request".to_string(), "x".to_string())
        .await
        .expect_err("陈旧 id 应被拒绝");
    assert!(
        err.starts_with("[interaction_stale] "),
        "应带结构化前缀：{err}"
    );
    assert!(err.contains("已过期"), "前缀之后保留原句：{err}");
    assert!(!pi.is_finished(), "拒绝陈旧提交不得退出连接循环");
}

/// 压缩中点停止、引擎不收尾——期限到，hub 收场：压缩请求按「已取消」
/// 返回、界面收到与引擎取消同形的收口事件、进程被结束。
#[tokio::test]
async fn cancel_during_compaction_with_silent_engine_times_out_and_closes() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 压缩回归测试");
        return;
    }
    let _timeout = SettleTimeoutGuard::arm(300);
    let pi = FakePi::spawn("compact-hang", "r2-compact-hang", "compact-hang", None, &[]).await;
    let control = pi.control.clone();
    let compact_task = tokio::spawn(async move { control.compact(None).await });
    pi.wait_event("compaction_status:true").await;

    pi.control.send_cancel().await;
    pi.wait_engine("\"abort\"").await;
    let result = tokio::time::timeout(FAKE_PI_WAIT, compact_task)
        .await
        .expect("引擎不收尾时压缩请求必须由 hub 收场，不能一直挂着")
        .expect("compact 任务异常退出");
    // 用户点了停止、引擎只是没收尾 → 语义上是「已取消」：压缩请求按已取消
    // 正常返回（不报错——报错会让界面弹「压缩失败」，与分隔线自相矛盾）。
    assert_eq!(
        result.expect("引擎不收尾时压缩请求不应报错"),
        json!({ "cancelled": true })
    );
    pi.wait_event("compaction_status:false").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    // 事件顺序：终态分隔线（与引擎取消同一字面量）→ 压缩结束；没有 Error。
    assert_eq!(
        pi.events(),
        vec![
            "divider:上下文压缩中…".to_string(),
            "compaction_status:true".to_string(),
            "divider:上下文压缩已取消".to_string(),
            "compaction_status:false".to_string(),
        ]
    );
    pi.wait_finished().await;
}

/// 引擎正常响应停止时，收尾期限随 compaction_end 解除——不会在期限到了
/// 之后误杀进程。
#[tokio::test]
async fn cancel_during_compaction_that_settles_clears_the_deadline() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 压缩回归测试");
        return;
    }
    let _timeout = SettleTimeoutGuard::arm(300);
    let pi = FakePi::spawn(
        "compact-cancel-ok",
        "r2-compact-cancel-ok",
        "compact-cancel-ok",
        None,
        &[],
    )
    .await;
    let control = pi.control.clone();
    let compact_task = tokio::spawn(async move { control.compact(None).await });
    pi.wait_event("compaction_status:true").await;
    pi.control.send_cancel().await;
    pi.wait_engine("\"abort\"").await;
    let result = tokio::time::timeout(FAKE_PI_WAIT, compact_task)
        .await
        .expect("引擎响应停止后压缩请求应立即返回")
        .expect("compact 任务异常退出");
    assert_eq!(
        result.expect("用户取消的压缩不是失败"),
        json!({ "cancelled": true })
    );
    // 远超测试期限：进程仍在，也没有超时错误。
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(!pi.is_finished(), "正常取消不得被收尾期限误杀");
    assert!(
        !pi.events().iter().any(|tag| tag.starts_with("error:")),
        "{:?}",
        pi.events()
    );
    // 会话还活着：普通回合照常。
    pi.control
        .send_prompt("after compaction".to_string().into())
        .await
        .unwrap();
    pi.wait_event("turn_complete:Complete").await;
}

/// 收尾期限只针对「点了停止、引擎不收尾」：引擎自己在跑的压缩超过期限
/// 也不会被杀（「坚决信任 pi」）。
#[tokio::test]
async fn normal_compaction_is_not_killed_by_settle_deadline() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 压缩回归测试");
        return;
    }
    let _timeout = SettleTimeoutGuard::arm(300);
    let pi = FakePi::spawn("compact-slow", "r2-compact-slow", "compact-slow", None, &[]).await;
    let control = pi.control.clone();
    let compact_task = tokio::spawn(async move { control.compact(None).await });
    pi.wait_event("compaction_status:true").await;
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(!pi.is_finished(), "没点停止的压缩不得被收尾期限杀掉");

    // 放行：引擎先回一条请求号对不上的响应，再回这一次的——调用方拿到的
    // 必须是自己的结果（按请求号路由）。
    pi.control
        .set_thinking_level("high".to_string())
        .await
        .unwrap();
    let result = tokio::time::timeout(FAKE_PI_WAIT, compact_task)
        .await
        .expect("压缩应在放行后结束")
        .expect("compact 任务异常退出");
    assert_eq!(result.expect("压缩成功")["summary"], "done");
    pi.wait_event("compaction_status:false").await;
    assert!(
        !pi.events().iter().any(|tag| tag.starts_with("error:")),
        "{:?}",
        pi.events()
    );
}

/// 重复压缩：第二个请求立即得到中文提示、不转发给引擎；响应按请求号路由。
#[tokio::test]
async fn duplicate_compact_gets_chinese_hint_and_responses_route_by_request_id() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 压缩回归测试");
        return;
    }
    let pi = FakePi::spawn(
        "compact-duplicate",
        "r2-compact-duplicate",
        "compact-slow",
        None,
        &[],
    )
    .await;
    let control = pi.control.clone();
    let first = tokio::spawn(async move { control.compact(None).await });
    pi.wait_event("compaction_status:true").await;

    let second = tokio::time::timeout(FAKE_PI_WAIT, pi.control.compact(None))
        .await
        .expect("重复的压缩请求应立即得到答复，不应挂着等引擎");
    let hint = second.expect_err("压缩进行中的第二个请求不应被转发");
    assert_eq!(hint, "上下文正在压缩，等它结束再试。", "与前端词典逐字相同");
    let forwarded = pi
        .engine_log()
        .lines()
        .filter(|line| line.contains("\"type\":\"compact\""))
        .count();
    assert_eq!(forwarded, 1, "第二个压缩请求不得发给引擎");

    pi.control
        .set_thinking_level("high".to_string())
        .await
        .unwrap();
    let result = tokio::time::timeout(FAKE_PI_WAIT, first)
        .await
        .expect("压缩应在放行后结束")
        .expect("compact 任务异常退出");
    assert_eq!(result.expect("第一个请求拿到自己的结果")["summary"], "done");
}

/// 引擎拒收提示词的英文原话不上屏；被拒的这笔账确定未送达。
#[tokio::test]
async fn prompt_rejected_during_compaction_shows_chinese() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 错误文案回归测试");
        return;
    }
    let _guard = lock_env();
    let session = "r2-reject";
    crate::pending_messages::drop_session(session);
    let entry =
        crate::pending_messages::record(session, "jishu-self", "during compaction").unwrap();
    let pi = FakePi::spawn(
        "reject",
        session,
        "reject",
        Some(PromptPayload::composed(
            "during compaction".to_string(),
            "during compaction".to_string(),
            vec![entry],
        )),
        &[],
    )
    .await;
    pi.wait_event("turn_complete:Error").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let errors: Vec<String> = pi
        .events()
        .iter()
        .filter(|tag| tag.starts_with("error:"))
        .cloned()
        .collect();
    assert_eq!(errors.len(), 1, "{:?}", pi.events());
    assert!(errors[0].contains("上下文正在压缩"), "{}", errors[0]);
    assert!(
        !errors[0].contains("Cannot submit"),
        "引擎英文原话不得上屏：{}",
        errors[0]
    );
    assert_eq!(
        ledger_states(session),
        vec!["during compaction|unsent".to_string()]
    );
    crate::pending_messages::drop_session(session);
}

/// 需求22（评审修复轮 R2 / C4）：执行器每轮的查询按会话回答——是不是任务
/// 会话、开没开不询问，都以 hub 的任务登记为准。修前这里透出的是全局配置
/// 里的一个布尔键，任一会话打开所有会话一起为真。
#[test]
fn hub_invoke_runner_capability_plugins_answers_per_session() {
    let project = tempfile::tempdir().unwrap();
    let root = project.path().to_string_lossy().to_string();
    let task_a =
        crate::task_launch::mark_task_session(&root, None, "sess-a", "jishu-task-runner", None)
            .unwrap();
    let task_c =
        crate::task_launch::mark_task_session(&root, None, "sess-c", "jishu-task-runner", None)
            .unwrap();
    crate::task_launch::set_no_ask_for_session(Some(&root), "sess-a", true).unwrap();

    let query = |params: serde_json::Value| {
        runner_capability_plugins(&params, &|project_root, session_id| {
            crate::task_launch::query_task_instance(project_root, session_id)
        })
        .unwrap()
    };

    // 任务 A（开）：任务会话、开、带任务号。
    let a = query(json!({ "session_id": "sess-a", "project_root": root }));
    assert_eq!(a["taskSession"], json!(true));
    assert_eq!(a["noAsk"], json!(true));
    assert_eq!(a["taskId"], json!(task_a.task_id));
    assert!(a.get("enabled").is_some(), "能力插件启用态照旧透出");
    // 任务 C（关）：任务会话，但不开——别的任务的开关不串过来。
    let c = query(json!({ "session_id": "sess-c", "project_root": root }));
    assert_eq!(c["taskSession"], json!(true));
    assert_eq!(c["noAsk"], json!(false), "一个任务开了，别的任务不受影响");
    assert_eq!(c["taskId"], json!(task_c.task_id));
    // 普通会话：不是任务会话，更谈不上不询问。
    let b = query(json!({ "session_id": "sess-b", "project_root": root }));
    assert_eq!(b["taskSession"], json!(false));
    assert_eq!(b["noAsk"], json!(false), "普通会话不得进入不询问");
    assert!(b["taskId"].is_null());
    // 没带会话号：无从判断，按「不是任务会话」回答。
    let none = query(json!({}));
    assert_eq!(none["taskSession"], json!(false));
    assert_eq!(none["noAsk"], json!(false));
    // 驼峰键同样认（扩展侧历史写法）。
    let camel = query(json!({ "sessionId": "sess-a", "projectRoot": root }));
    assert_eq!(camel["noAsk"], json!(true));
    // 查询本身出错：不把不询问给到不确定的会话。
    let failed = runner_capability_plugins(&json!({ "session_id": "sess-x" }), &|_, _| {
        Err("编排库打不开".to_string())
    })
    .unwrap();
    assert_eq!(failed["taskSession"], json!(false));
    assert_eq!(failed["noAsk"], json!(false));
}

// ═══════════════════════════════════════════════════════════════════════════
// v0.9.8 评审修复轮 R3：登记先于首条 prompt / 账本身份与时刻 / 回执到过不落
// 终态 / 等命令清单 / 回执认不出时不猜 / 善中期才到的「已处理」
// ═══════════════════════════════════════════════════════════════════════════

/// 评审修复轮 R3（P1-1）：会话解析回调早于首条 prompt 写出。主会话的任务改
/// 绑、节点会话号的落库都靠这个先后，所以回调没返回之前首条 prompt 不能先
/// 写出去。回调里卡住等测试放行：放行之前引擎流水里不得出现 prompt。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_resolved_hook_runs_before_the_first_prompt() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 回归测试");
        return;
    }
    let session = "r3-resolve-order";
    let release = std::env::temp_dir().join(format!(
        "fake_pi_release_{}_r3_resolve_order",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&release);
    let pi = FakePi::spawn_with_hook(
        "resolve-order",
        session,
        "turn",
        Some("hello".to_string().into()),
        &[],
        Some(Arc::new({
            let release = release.clone();
            move |sid: &str, log_path: &std::path::Path| {
                use std::io::Write as _;
                // 一次写完整行：hub 与引擎两个进程往同一份流水里追加。
                let mark = |line: String| {
                    if let Ok(mut file) = std::fs::OpenOptions::new()
                        .append(true)
                        .create(true)
                        .open(log_path)
                    {
                        let _ = file.write_all(format!("{line}\n").as_bytes());
                    }
                };
                mark(format!("HOOK_ENTER {sid}"));
                // 等测试放行：放行文件出现之前不返回。
                let deadline = std::time::Instant::now() + FAKE_PI_WAIT;
                while !release.exists() {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "测试没有放行会话解析回调"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
                mark("HOOK_LEAVE".to_string());
            }
        })),
    )
    .await;
    pi.wait_engine("HOOK_ENTER").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !pi.engine_log().contains("\"type\":\"prompt\""),
        "回调还没返回，首条 prompt 不能先写出去：{:?}",
        pi.engine_log()
    );
    std::fs::write(&release, "go").unwrap();
    pi.wait_event("turn_complete:Complete").await;
    let log = pi.engine_log();
    let position = |needle: &str| {
        log.lines()
            .position(|line| line.contains(needle))
            .unwrap_or_else(|| panic!("引擎流水里找不到 {needle:?}：{log}"))
    };
    assert!(
        position("HOOK_LEAVE") < position("\"type\":\"prompt\""),
        "会话解析回调返回之后才写首条 prompt：{log}"
    );
    assert!(
        log.contains(&format!("HOOK_ENTER {session}")),
        "回调拿到的是真实会话号：{log}"
    );
    let _ = std::fs::remove_file(&release);
}

/// 评审修复轮 R3（P2-1）：没带入口账的发送是扩展命令——落地时新记的账要把
/// 身份交回登记，「已处理」才销得掉。修前身份没回登记：这一行留成「未送达」，
/// 还会作为「最早的落地账」抢走下一条消息的回执。
#[tokio::test]
async fn entryless_extension_command_leaves_no_ledger_row() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 账本回归测试");
        return;
    }
    let _guard = lock_env();
    let session = "r3-entryless";
    crate::pending_messages::drop_session(session);
    let pi = FakePi::spawn(
        "entryless",
        session,
        "turn",
        Some("/todos".to_string().into()),
        &[("FAKE_PI_CMDS", "todos")],
    )
    .await;
    pi.wait_event("turn_complete:Handled").await;
    assert_eq!(
        ledger_states(session),
        Vec::<String>::new(),
        "扩展命令已处理：它那一行账要销掉"
    );

    // 随后一条普通消息（同样没带入口账）：被自己的回执销掉。
    pi.control
        .send_prompt("second message".to_string().into())
        .await
        .unwrap();
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        ledger_states(session),
        Vec::<String>::new(),
        "账本清空：没有残行，也没有哪一行抢走别人的回执"
    );
    crate::pending_messages::drop_session(session);
}

/// 评审修复轮 R3（P2-2）：落地时才新记的账，时刻取在写引擎**之前**。读者先
/// 不读，写出被管道挡住；写出期间把记账时钟拨后——「写出之后才取时刻」的
/// 写法会记下拨后的值，加载对账就对不上它自己的那条消息。
#[tokio::test]
async fn entryless_send_is_recorded_with_the_time_before_the_write() {
    let _guard = lock_env();
    use crate::pending_messages::PinnedLedgerClock;
    let session = "r3-write-time";
    crate::pending_messages::drop_session(session);
    // 读者 1.5 秒后才开始读：在那之前管道写满，写出不返回。
    let mut reader = tokio::process::Command::new("node")
        .args([
            "-e",
            "process.stdin.pause(); setTimeout(() => { process.stdin.resume(); process.stdin.on('data', () => {}); }, 1500); setTimeout(() => process.exit(0), 5000);",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .expect("spawn slow reader");
    let stdin = reader.stdin.take().expect("reader stdin");
    let stdin = Arc::new(TokioMutex::new(stdin));
    let before = 1_700_000_000_000_i64;
    let clock = PinnedLedgerClock::pin(before);
    let payload = "x".repeat(256 * 1024);
    let writer_session = session.to_string();
    let writer_stdin = stdin.clone();
    let writer = tokio::spawn(async move {
        super::write_prompt(
            &writer_stdin,
            1,
            &payload,
            &writer_session,
            "jishu-self",
            &[],
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(!writer.is_finished(), "前置：读者不读，写出还没返回");
    // 写出还卡着：此刻把记账时钟拨后 100 秒。
    clock.advance_to(before + 100_000);
    writer.await.unwrap().unwrap();
    let rows = crate::pending_messages::dedupe_against(session, &[]);
    assert_eq!(rows.len(), 1, "一次发送一笔账");
    assert_eq!(rows[0].sent_at, before, "记账时刻是写出之前取的那个");
    drop(clock);
    crate::pending_messages::drop_session(session);
    let _ = tokio::time::timeout(FAKE_PI_WAIT, reader.wait()).await;
}

/// 评审修复轮 R3（P2-12）：回执到的那一刻账本打不开、销账没落库——回合收口
/// 时再销一次。修前收口一律落终态：已落盘的消息从此显示成「未送达」。
#[tokio::test]
async fn receipt_settle_is_retried_when_the_turn_ends() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 账本回归测试");
        return;
    }
    let _guard = lock_env();
    use crate::pending_messages::fail_next_opens;
    let session = "r3-receipt-retry";
    crate::pending_messages::drop_session(session);
    let entry = crate::pending_messages::record(session, "jishu-self", "fresh message").unwrap();
    let pi = FakePi::spawn(
        "receipt-retry",
        session,
        "gated",
        Some(PromptPayload::composed(
            "fresh message".to_string(),
            "fresh message".to_string(),
            vec![entry],
        )),
        &[],
    )
    .await;
    pi.wait_engine("GATED").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    // 放行回执；回执到的那一刻，账本恰好打不开（一次）。
    fail_next_opens(1);
    pi.control
        .set_thinking_level("high".to_string())
        .await
        .unwrap();
    pi.wait_engine("PERSIST").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        ledger_states(session),
        vec!["fresh message|sent".to_string()],
        "销账没落库：账仍是落地账"
    );

    // 回合收口：再销一次。
    pi.control
        .set_thinking_level("high".to_string())
        .await
        .unwrap();
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        ledger_states(session),
        Vec::<String>::new(),
        "收口时补销，账本清空"
    );
    crate::pending_messages::drop_session(session);
}

/// 评审修复轮 R3（P2-12）：回执到时与收口时账本都打不开——这笔账也不落终
/// 态（消息已经落盘）；之后加载按时间规则把它销掉。
#[tokio::test]
async fn send_whose_receipt_arrived_is_never_finalized_as_unsent() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 账本回归测试");
        return;
    }
    let _guard = lock_env();
    use crate::pending_messages::fail_next_opens;
    let session = "r3-receipt-arrived";
    crate::pending_messages::drop_session(session);
    let entry = crate::pending_messages::record(session, "jishu-self", "fresh message").unwrap();
    let pi = FakePi::spawn(
        "receipt-arrived",
        session,
        "gated",
        Some(PromptPayload::composed(
            "fresh message".to_string(),
            "fresh message".to_string(),
            vec![entry],
        )),
        &[],
    )
    .await;
    pi.wait_engine("GATED").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    fail_next_opens(2);
    pi.control
        .set_thinking_level("high".to_string())
        .await
        .unwrap();
    pi.wait_engine("PERSIST").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    pi.control
        .set_thinking_level("high".to_string())
        .await
        .unwrap();
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        ledger_states(session),
        vec!["fresh message|sent".to_string()],
        "回执到过：不落终态，账仍是落地账"
    );
    // 之后加载：这条消息已在会话文件里（落盘时刻在记账之后）——按时间销掉。
    let unsent =
        crate::pending_messages::dedupe_against(session, &[crate::util::now_ms() + 60_000]);
    assert!(
        unsent.is_empty(),
        "已送达的消息不显示成「未送达」：{unsent:?}"
    );
    crate::pending_messages::drop_session(session);
}

/// 评审修复轮 R3（P2-6）：引擎对命令清单回失败——立即按「没有扩展命令」往
/// 下发，不白等满上限。修前失败响应不算答复，首条消息要等 10 秒才发出。
#[tokio::test]
async fn failed_command_list_response_ends_the_wait_at_once() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 回归测试");
        return;
    }
    let started = std::time::Instant::now();
    let pi = FakePi::spawn(
        "cmds-fail",
        "r3-cmds-fail",
        "turn",
        Some("/todos hello".to_string().into()),
        &[("FAKE_PI_CMDS_MODE", "fail")],
    )
    .await;
    pi.wait_event("turn_complete:Complete").await;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "引擎回失败也该立刻往下发，不等满上限：用了 {:?}",
        started.elapsed()
    );
    assert_eq!(pi.engine_prompts(), vec!["/todos hello".to_string()]);
    assert!(
        !pi.events().iter().any(|tag| tag.starts_with("error:")),
        "清单拿不到不是错误：{:?}",
        pi.events()
    );
}

/// 评审修复轮 R3（P2-6）：等命令清单期间引擎发来的别的事件行不能丢——交回
/// 主循环、先后不变。
#[tokio::test]
async fn lines_arriving_during_the_wait_are_not_lost() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 回归测试");
        return;
    }
    let pi = FakePi::spawn(
        "cmds-late-line",
        "r3-cmds-late-line",
        "turn",
        Some("/todos".to_string().into()),
        &[
            ("FAKE_PI_CMDS_MODE", "late-line"),
            ("FAKE_PI_CMDS", "todos"),
        ],
    )
    .await;
    pi.wait_event("turn_complete:Handled").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        pi.events(),
        vec![
            "divider:流程执行".to_string(),
            "turn_complete:Handled".to_string()
        ],
        "等清单期间到达的分隔线照常上屏，且排在后面的回执之前"
    );
}

/// 评审修复轮 R3（P2-10）：引擎不回带请求号，回合进行中转发的命令失败了——
/// 这条失败认不出属于谁（当前回合的发送也在等回执）。只报一条可恢复错误，
/// 不动回合、不落终态；回合照常收口。修前把它记成当前回合失败。
#[tokio::test]
async fn unattributable_failure_only_reports_a_recoverable_error() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 回归测试");
        return;
    }
    let _guard = lock_env();
    let session = "r3-noecho";
    crate::pending_messages::drop_session(session);
    let pi = FakePi::spawn(
        "noecho",
        session,
        "hold",
        Some("hello".to_string().into()),
        &[
            ("FAKE_PI_NO_ECHO", "1"),
            ("FAKE_PI_CMDS", "todos"),
            ("FAKE_PI_EXT", "fail"),
        ],
    )
    .await;
    pi.wait_engine("SENT agent_start").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    pi.control
        .send_prompt("/todos".to_string().into())
        .await
        .unwrap();
    pi.wait_event("error:").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        pi.events(),
        vec!["error:智能体返回了错误：command handler crashed".to_string()],
        "认不出属于谁的失败：只报一条可恢复错误，不发回合结束"
    );

    // 回合还在跑：放行后照常收口。
    pi.control
        .set_thinking_level("high".to_string())
        .await
        .unwrap();
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        pi.events()
            .iter()
            .filter(|tag| tag.starts_with("turn_complete:"))
            .cloned()
            .collect::<Vec<_>>(),
        vec!["turn_complete:Complete".to_string()],
        "回合照常收口，没有被记成失败"
    );
    crate::pending_messages::drop_session(session);
}

/// 评审修复轮 R3（评审建议补）：空闲时发的扩展命令还没回「已处理」就点了停
/// 止、又缓冲了一条普通消息——「已处理」在停止善中期才到。hub 合成一条
/// Handled，缓冲的消息照常发出并收口，账本清空。
#[tokio::test]
async fn handled_arriving_in_cancel_pending_resends_the_buffered_message() {
    if !node_available().await {
        eprintln!("node 不可用，跳过假 pi 回归测试");
        return;
    }
    let _guard = lock_env();
    let session = "r3-handled-cancel";
    crate::pending_messages::drop_session(session);
    let pi = FakePi::spawn(
        "handled-cancel",
        session,
        "turn",
        Some("/todos".to_string().into()),
        &[("FAKE_PI_CMDS", "todos"), ("FAKE_PI_EXT", "handled-late")],
    )
    .await;
    // 引擎压着「已处理」没回；此刻点停止，再缓冲一条普通消息。
    pi.wait_engine("EXT_HELD").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    pi.control.send_cancel().await;
    pi.wait_engine("\"abort\"").await;
    let second = crate::pending_messages::record(session, "jishu-self", "second message").unwrap();
    pi.control
        .send_prompt(PromptPayload::composed(
            "second message".to_string(),
            "second message".to_string(),
            vec![second],
        ))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        pi.engine_prompts(),
        vec!["/todos".to_string()],
        "缓冲的消息还没发"
    );

    // 放行：「已处理」这时才到。
    pi.control
        .set_thinking_level("high".to_string())
        .await
        .unwrap();
    pi.wait_event("turn_complete:Complete").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let completions: Vec<String> = pi
        .events()
        .iter()
        .filter(|tag| tag.starts_with("turn_complete:"))
        .cloned()
        .collect();
    assert_eq!(
        completions,
        vec![
            "turn_complete:Handled".to_string(),
            "turn_complete:Complete".to_string()
        ],
        "Handled 一条；缓冲的消息重发后正常收口"
    );
    assert_eq!(
        pi.engine_prompts(),
        vec!["/todos".to_string(), "second message".to_string()],
        "缓冲的消息原样发出"
    );
    assert_eq!(ledger_states(session), Vec::<String>::new(), "账本清空");
    crate::pending_messages::drop_session(session);
}
