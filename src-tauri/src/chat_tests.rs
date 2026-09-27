//! 注入管线集成测试（M7）：staging 迁移 → compose 净化 → 说明块组装。
//! 不拉起真实 AppState（Tauri State 不可构造），而以纯函数组合复现
//! compose_tool_message 的核心序列（迁移 + 读取 + 渲染 + 净化），锁定
//! P0-0/P0-1/P0-3 三类回归。
#[cfg(test)]
mod tests {
    use crate::agent::tool_plugin as tp;
    use std::sync::Arc;

    fn pi_only_plugin() -> tp::ToolPlugin {
        use crate::agent::manifest::schema::*;
        tp::ToolPlugin::for_test(
            Arc::new(AgentManifestFile {
                schema: 1,
                kind: ManifestKind::Tool,
                info: InfoSection {
                    id: "pi-only".into(),
                    display_name: "pi-only".into(),
                    icon: String::new(),
                    install_hint: None,
                },
                probe: None,
                transport: None,
                config: None,
                session: None,
                capabilities: None,
                pi_extension: Some(PiExtensionSection {
                    entry: Some("x.ts".into()),
                    target_agent: "jishu-self".into(),
                    tools: vec![],
                }),
                mcp: None,
                panel: None,
                skill: None,
                skills: None,
                tool: None,
            }),
            Default::default(),
            true,
        )
    }

    fn injectable_plugin() -> tp::ToolPlugin {
        use crate::agent::manifest::schema::*;
        tp::ToolPlugin::for_test(
            Arc::new(AgentManifestFile {
                schema: 1,
                kind: ManifestKind::Tool,
                info: InfoSection {
                    id: "gh-cli".into(),
                    display_name: "GitHub".into(),
                    icon: String::new(),
                    install_hint: None,
                },
                probe: None,
                transport: None,
                config: None,
                session: None,
                capabilities: None,
                pi_extension: None,
                mcp: None,
                panel: None,
                skill: None,
                skills: None,
                tool: Some(ToolSection {
                    description: "GitHub 查询".into(),
                    usage: "gh repo view".into(),
                    example: None,
                    notes: None,
                }),
            }),
            Default::default(),
            true,
        )
    }

    /// compose_tool_message 核心序列的纯函数复刻（迁移→读取→过滤→渲染）。
    /// v0.9.0 需求3 方案 C：前端不再嵌 [JISHU-TOOLS] 文本标记，净化步骤
    /// 已删除（compose 只做 块前缀 + 原文直拼）。
    fn compose_core(session_id: &str, message: &str, pool: &[tp::ToolPlugin]) -> String {
        tp::migrate_session_tools(tp::STAGING_SESSION_KEY, session_id);
        let ids = tp::get_session_tools(session_id);
        if ids.is_empty() {
            return message.to_string();
        }
        let matched: Vec<&tp::ToolPlugin> = pool
            .iter()
            .filter(|p| ids.iter().any(|id| id == p.id()))
            .collect();
        if matched.is_empty() {
            return message.to_string();
        }
        let block = tp::render_tool_block(&matched);
        if block.trim().is_empty() {
            return message.to_string();
        }
        format!("{block}\n\n{message}")
    }

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn compose_first_message_migrates_staging_and_injects() {
        let _g = lock();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        // 新会话：用户在输入框勾选（落暂存键）→ 首条消息（pending id）
        let mut map = std::collections::HashMap::new();
        map.insert(
            tp::STAGING_SESSION_KEY.to_string(),
            vec!["gh-cli".to_string()],
        );
        tp::set_session_tools_map_for_test(&map);

        let pool = vec![injectable_plugin(), pi_only_plugin()];
        let out = compose_core("pending-1000", "列出我的仓库", &pool);
        // 注入块包含说明
        assert!(out.contains("<jishu-tool-plugins>"));
        assert!(out.contains("gh repo view"));
        // v0.9.0 需求3：回放派生——块剥净、正文还原、id 快照可提取
        let (clean, ids) = tp::extract_tool_snapshot(&out);
        assert_eq!(clean, "列出我的仓库");
        assert_eq!(ids, vec!["gh-cli".to_string()]);
        // 暂存键已清空、内容已迁移到 pending
        assert!(tp::get_session_tools(tp::STAGING_SESSION_KEY).is_empty());
        assert_eq!(
            tp::get_session_tools("pending-1000"),
            vec!["gh-cli".to_string()]
        );
        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn compose_session_resolution_migrates_pending_to_real_id() {
        let _g = lock();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        let mut map = std::collections::HashMap::new();
        map.insert("pending-2000".to_string(), vec!["gh-cli".to_string()]);
        tp::set_session_tools_map_for_test(&map);

        // 会话解析回调同款迁移
        tp::migrate_session_tools("pending-2000", "real-abc");
        assert_eq!(
            tp::get_session_tools("real-abc"),
            vec!["gh-cli".to_string()]
        );
        assert!(tp::get_session_tools("pending-2000").is_empty());
        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn compose_no_tools_returns_message_untouched() {
        // 无工具时消息原样（分层契约：无块即无快照，回放派生得空 ids）
        let out = compose_core("s-none", "hello", &[]);
        assert_eq!(out, "hello");
        let (clean, ids) = tp::extract_tool_snapshot(&out);
        assert_eq!(clean, "hello");
        assert!(ids.is_empty());
    }
}

// ── v0.9.5 需求5 T9：识图路由（解析与话术合成纯函数）──
mod image_dispatch_tests {
    use crate::chat::{compose_image_dispatch_hint, resolve_mcp_vision_tools, ImageDispatchRoute};

    #[test]
    fn mcp_tools_config_empty_falls_back_to_declarations() {
        let declared = vec![
            ("zai-mcp-server".to_string(), vec!["analyze_image".to_string()]),
            ("other".to_string(), vec!["a".to_string(), "b".to_string()]),
        ];
        let tools = resolve_mcp_vision_tools("", &declared);
        assert_eq!(
            tools,
            vec![
                "zai-mcp-server__analyze_image",
                "other__a",
                "other__b"
            ]
        );
    }

    #[test]
    fn mcp_tools_short_name_completed_and_unknown_passthrough() {
        let declared = vec![("zai-mcp-server".to_string(), vec!["analyze_image".to_string()])];
        let tools = resolve_mcp_vision_tools("analyze_image, custom__tool, 未声明名", &declared);
        assert_eq!(
            tools,
            vec![
                "zai-mcp-server__analyze_image",
                "custom__tool",
                "未声明名"
            ]
        );
    }

    #[test]
    fn default_hint_contains_scene_routing_and_fallbacks() {
        // 显式配置工具时点名直呼（钉定场景）
        let route = ImageDispatchRoute {
            custom_prompt: None,
            mcp_tools: vec!["some-mcp__analyze".to_string()],
            subagent_model: Some("zhipu/glm-5.3-flash".to_string()),
        };
        let hint = compose_image_dispatch_hint(&route);
        assert!(hint.contains("简单识别"), "缺简单识别路由");
        assert!(hint.contains("复杂分析"), "缺复杂分析路由");
        assert!(hint.contains("some-mcp__analyze"));
        assert!(hint.contains("zhipu/glm-5.3-flash"));
        assert!(hint.contains(r#""action":"list""#), "缺清单查询步骤");
        assert!(hint.contains("改用另一条途径"), "缺互为兜底");
        assert!(hint.contains("严禁编造图片内容"), "缺双败如实告知");
    }

    #[test]
    fn default_hint_without_config_lets_agent_discover_mcp_itself() {
        // 用户裁决：默认不点名任何具体 MCP——模型自行搜索发现识图工具
        let route = ImageDispatchRoute {
            custom_prompt: None,
            mcp_tools: vec![],
            subagent_model: Some("zhipu/glm-5.3-flash".to_string()),
        };
        let hint = compose_image_dispatch_hint(&route);
        assert!(hint.contains("先自行发现识图工具"), "缺自搜索指引");
        assert!(hint.contains("hub_mcp_list"), "缺全量列举入口");
        assert!(hint.contains("describe"), "缺确认步骤");
        assert!(!hint.contains("zai"), "默认话术不得点名具体 MCP 服务");
    }

    #[test]
    fn default_hint_without_tools_or_model_degrades_gracefully() {
        let route = ImageDispatchRoute {
            custom_prompt: None,
            mcp_tools: vec![],
            subagent_model: None,
        };
        let hint = compose_image_dispatch_hint(&route);
        assert!(hint.contains("先自行发现识图工具"), "无工具时应走自搜索指引");
        assert!(!hint.contains("model 参数填"), "无模型时不应有 model 指引");
    }

    #[test]
    fn custom_prompt_placeholders_substituted() {
        let route = ImageDispatchRoute {
            custom_prompt: Some("工具：{{mcp_tools}}；模型：{{subagent_model}}".to_string()),
            mcp_tools: vec!["p__t".to_string()],
            subagent_model: Some("prov/m".to_string()),
        };
        let hint = compose_image_dispatch_hint(&route);
        assert_eq!(hint, "工具：p__t；模型：prov/m");
    }
}
