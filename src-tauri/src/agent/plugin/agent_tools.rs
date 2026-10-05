//! agent::plugin 子模块（v0.9.5 三轮评审拆分：零逻辑变更纯移动，
//! 来源与拆分说明见 plugin.rs 文件头 §12 处置说明）。

use super::*;

/// 单条 agent-tool 声明（物化文件 agent-tools.json 的条目形状；与前端
/// AgentToolDecl 及 plugin-invoke 扩展的读取端三方同形）。
/// 三轮评审 P1-7：跨端序列化一律 snake_case（§4）——物化文件启动 ensure
/// 全量重写，无存量 camelCase 数据兼容包袱；前端/扩展读取端同步改。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentToolEntry {
    pub plugin_id: String,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<serde_json::Value>,
}

/// 物化启用的 agent-tool 清单到 `~/.jishu-hub/agent-tools.json`——plugin-invoke
/// pi 扩展（agent 进程）运行时读取的数据源（跨进程单向：hub 权威写，扩展只读）。
/// 调用时机：启动 ensure + 每次启停成功后（set_plugin_enabled 尾部）。
pub fn materialize_agent_tools() {
    let disabled: std::collections::HashSet<String> =
        load_plugin_config().disabled.iter().cloned().collect();
    let mut entries: Vec<AgentToolEntry> = Vec::new();
    for (id, manifest) in composed_session_manifests() {
        if disabled.contains(&id) {
            continue;
        }
        let Some(tools) = manifest.get("agent-tool").and_then(|v| v.as_array()) else {
            continue;
        };
        for tool in tools {
            let name = tool.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            entries.push(AgentToolEntry {
                plugin_id: id.clone(),
                name: name.to_string(),
                description: tool
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                parameters: tool.get("parameters").cloned(),
            });
        }
    }
    // 6c：全局名唯一（跨插件撞名保留首个——按清单排序稳定）。
    let mut seen = std::collections::HashSet::new();
    entries.retain(|e| seen.insert(e.name.clone()));
    let path = crate::agent::manifest::hub_home().join("agent-tools.json");
    if let Ok(json) = serde_json::to_string_pretty(&entries) {
        let _ = crate::util::atomic_write(&path, json.as_bytes());
    }
}

/// agent-tool 名冲突检查（安装/保存清单时调用——6c：与已装插件的声明撞名
/// 即拒绝，保证 agent 工具名全局唯一）。返回 Err(冲突描述)。
pub fn ensure_agent_tool_names_free(declarant: &str, names: &[String]) -> Result<(), String> {
    let disabled: std::collections::HashSet<String> =
        load_plugin_config().disabled.iter().cloned().collect();
    for (id, manifest) in composed_session_manifests() {
        if id == declarant {
            continue; // 自身旧声明（更新场景）不算冲突。
        }
        if disabled.contains(&id) {
            continue; // 禁用插件的声明不占用名（物化已排除）。
        }
        if let Some(tools) = manifest.get("agent-tool").and_then(|v| v.as_array()) {
            for tool in tools {
                if let Some(name) = tool.get("name").and_then(|v| v.as_str()) {
                    if names.iter().any(|n| n == name) {
                        return Err(format!(
                            "agent-tool 名 {name:?} 已被插件 {id} 声明（agent 工具名须全局唯一）"
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

/// 读取物化的 agent-tool 清单（pi_rpc_runtime 的 plugin_invoke 闸门消费；
/// 文件缺失/损坏返回空集——闸门自然拒绝，扩展注册面为空）。
pub fn load_agent_tools() -> Vec<AgentToolEntry> {
    let path = crate::agent::manifest::hub_home().join("agent-tools.json");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

#[cfg(test)]
mod agent_tool_tests {
    use super::*;

    fn composed_toml(id: &str, tool: Option<&str>) -> String {
        let mut s = format!(
            "[plugin]\nid = \"{id}\"\nname = \"t\"\nkind = \"session-composed\"\n\n[source]\ntype = \"messages\"\n\n[render]\ncomponent = \"render.list\"\nmount = \"dock-panel\"\n"
        );
        if let Some(name) = tool {
            s.push_str(&format!(
                "\n[[agent-tool]]\nname = \"{name}\"\ndescription = \"测试工具\"\n"
            ));
        }
        s
    }

    /// 6b/6c：物化（启用收录/禁用排除/撞名去重）+ 撞名拒绝 + roundtrip。
    #[test]
    fn materialize_and_conflict_checks() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());

        save_composed_manifest(
            "session.tool-a",
            &composed_toml("session.tool-a", Some("export_session")),
        )
        .unwrap();
        save_composed_manifest(
            "session.tool-b",
            &composed_toml("session.tool-b", Some("search_docs")),
        )
        .unwrap();
        // 禁用 tool-b：物化面排除。
        let _ = set_plugin_enabled("session.tool-b", false);

        materialize_agent_tools();
        let tools = load_agent_tools();
        assert_eq!(tools.len(), 1, "禁用插件的 agent-tool 不物化：{tools:?}");
        assert_eq!(tools[0].name, "export_session");
        assert_eq!(tools[0].plugin_id, "session.tool-a");
        assert!(tools[0].description.contains("测试工具"));

        // 6c：撞名拒绝（session.tool-c 声明 export_session → 与 tool-a 冲突）。
        let err = save_composed_manifest(
            "session.tool-c",
            &composed_toml("session.tool-c", Some("export_session")),
        )
        .unwrap_err();
        assert!(err.contains("全局唯一"), "got: {err}");

        // 无 agent-tool 的清单不受影响（兼容旧路径）。
        save_composed_manifest("session.pure", &composed_toml("session.pure", None)).unwrap();

        // 启停联动：重新启用 tool-b → 物化两条。
        let _ = set_plugin_enabled("session.tool-b", true);
        let tools = load_agent_tools();
        assert_eq!(tools.len(), 2);

        std::env::remove_var("JISHU_HUB_HOME");
    }

    /// 物化文件缺失/损坏 → 空集（闸门自然拒绝）。
    #[test]
    fn load_agent_tools_tolerates_missing_file() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        assert!(load_agent_tools().is_empty());
        std::fs::write(tmp.path().join("agent-tools.json"), "not-json").unwrap();
        assert!(load_agent_tools().is_empty());
        std::env::remove_var("JISHU_HUB_HOME");
    }
}
