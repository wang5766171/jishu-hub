//! 工具渲染意图（render intent，v0.8.0 需求2 Phase 1 → v0.9.0 需求4 v2）：
//! EventNormalizer 产出 ToolUseStart 时调用，把 agent 方言的工具名收敛为
//! 中立的视图分类 + 位置信息。前端 UI 只做「意图→组件」纯映射（直播与
//! 回放同源），不再解析工具输入。
//!
//! v1 规则 = 前端 classifyToolName（2026-08-21 快照）逐条移植。v2（需求4）：
//! ①分类唯一源收敛完成——前端 classifyToolName fallback 已删除（无 view 的
//! 旧块按 other 渲染，版本级无旧数据兼容裁决）；②contains("read") 模糊项
//! 收紧为精确项；③FileDelete 死枚举激活（codex fileChange delete）；
//! ④classify_name_for per-agent 覆写钩子（各 runtime 入口传入 agent id，
//! 覆写表待 manifest agent 实际案例填入）。后续新增工具分类只改本模块。
//!
//! 本模块同时持有**交互工具权威名单**（02 §1.6）：前端 8 名单与后端
//! is_elicitation_only_tool 3 名单的并集收敛于此；前端名单保留为渲染快
//! 路径，一致性由 vitest 锁定（名单不经 wire 下发）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 中立视图分类（与前端 ToolKind 一一对应，wire 用 snake_case）。
/// v2（v0.9.0 需求4）：FileDelete 已激活（file_delete/delete_file/remove_file
/// 精确项 + codex fileChange delete 变更投影）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolViewKind {
    FileRead,
    FileWrite,
    FileEdit,
    FileDelete,
    ShellExec,
    Search,
    Web,
    Think,
    Subtask,
    Other,
}

/// 位置信息（DSH presentationMeta 思想）：归一化层一次提取，随事件/
/// 持久化块携带，回放不再解析工具输入。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewLocation {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolView {
    pub kind: ToolViewKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locations: Vec<ViewLocation>,
}

/// 分类 + 提取位置。工具名与输入均为 agent 方言原文。
pub fn classify_tool_view(tool: &str, input: &Value) -> ToolView {
    ToolView {
        kind: classify_name(tool),
        locations: extract_locations(input),
    }
}

/// v2 分类 + 提取位置（v0.9.0 需求4）：先查 agent 方言覆写表，未命中回落
/// 全局规则。各 runtime 归一化入口已知自家 agent id，经此入口分类。
pub fn classify_tool_view_for(agent: &str, tool: &str, input: &Value) -> ToolView {
    ToolView {
        kind: classify_name_for(agent, tool),
        locations: extract_locations(input),
    }
}

/// agent 方言覆写表（v2 声明驱动钩子）：同一工具名在不同 agent 语义不同、
/// 或全局表未收录的 agent 专属名，在此逐条声明。**初始为空**——填表触发
/// 条件即归档重启条件：manifest agent 实际出现分类偏差时。
fn agent_tool_overrides(_agent: &str) -> &'static [(&'static str, ToolViewKind)] {
    &[]
}

/// v2：per-agent 分类入口——覆写表优先，全局规则兜底。
pub fn classify_name_for(agent: &str, name: &str) -> ToolViewKind {
    if let Some((_, kind)) = agent_tool_overrides(agent)
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
    {
        return *kind;
    }
    classify_name(name)
}

/// v1→v2 分类规则（v0.9.0 需求4）：
/// - `file_read`：read/view_file/view 精确 + read_file/view_image（v2 收紧：
///   删除 contains("read") 唯一模糊项——真实受益者 codex read_file 收编为精确项）；
/// - `file_delete`：file_delete/delete_file/remove_file 精确（v2 激活死枚举：
///   codex fileChange 的 delete 变更合成 file_delete）；
/// - `file_edit`：edit/multiedit/str_replace/patch/replace/edit_file/
///   modify_file/file_edit + apply_patch/apply_changes；
/// - `file_write`：write/create_file/write_file/file_write；
/// - `shell_exec`：bash/shell/exec/execute_command/run_shell_command +
///   powershell（v0.9.1 需求3 #3：pi 可选原生 PowerShell 工具，Windows）；
/// - `search`：grep/search_files/ripgrep/grep_search/glob/find_files/
///   list_files/list_directory；
/// - `web`：webfetch/fetch/web_fetch/websearch/web_search/google_web_search；
/// - `subtask`：task 精确 + subagent_ 前缀 + invoke_agent；
/// - `think`：thinking/think/update_topic；
/// - 兜底 other。
pub fn classify_name(name: &str) -> ToolViewKind {
    let n = name.to_ascii_lowercase();
    if n == "read" || n == "view_file" || n == "view" || n == "read_file" || n == "view_image" {
        return ToolViewKind::FileRead;
    }
    if n == "file_delete" || n == "delete_file" || n == "remove_file" {
        return ToolViewKind::FileDelete;
    }
    if n == "edit"
        || n == "multiedit"
        || n == "str_replace"
        || n == "patch"
        || n == "replace"
        || n == "edit_file"
        || n == "modify_file"
        || n == "file_edit"
    {
        return ToolViewKind::FileEdit;
    }
    if n == "write" || n == "create_file" || n == "write_file" || n == "file_write" {
        return ToolViewKind::FileWrite;
    }
    if n == "apply_patch" || n == "apply_changes" {
        return ToolViewKind::FileEdit;
    }
    if n == "bash"
        || n == "shell"
        || n == "exec"
        || n == "execute_command"
        || n == "run_shell_command"
        || n == "powershell"
    {
        return ToolViewKind::ShellExec;
    }
    if n == "grep" || n == "search_files" || n == "ripgrep" || n == "grep_search" {
        return ToolViewKind::Search;
    }
    if n == "glob" || n == "find_files" || n == "list_files" || n == "list_directory" {
        return ToolViewKind::Search;
    }
    if n == "webfetch" || n == "fetch" || n == "web_fetch" {
        return ToolViewKind::Web;
    }
    if n == "websearch" || n == "web_search" || n == "google_web_search" {
        return ToolViewKind::Web;
    }
    if n == "task" || n.starts_with("subagent_") || n == "invoke_agent" {
        return ToolViewKind::Subtask;
    }
    if n == "thinking" || n == "think" || n == "update_topic" {
        return ToolViewKind::Think;
    }
    ToolViewKind::Other
}

/// 从工具输入提取位置：常见键 file_path / path / filename / notebook_path
/// （v1 取第一个命中；含 line 可选整型行号）。输入缺失/非对象 → 空。
pub fn extract_locations(input: &Value) -> Vec<ViewLocation> {
    let Some(obj) = input.as_object() else {
        return Vec::new();
    };
    for key in ["file_path", "path", "filename", "notebook_path"] {
        if let Some(path) = obj.get(key).and_then(Value::as_str) {
            if path.is_empty() {
                continue;
            }
            let line = obj
                .get("line")
                .or_else(|| obj.get("line_number"))
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok());
            return vec![ViewLocation {
                path: path.to_string(),
                line,
            }];
        }
    }
    Vec::new()
}

/// **交互工具权威名单**（02 §1.6）：前端 interaction-tools.ts 8 名单与
/// 后端原 is_elicitation_only_tool 3 名单的并集（8 ⊇ 3，收敛为前端全集）。
/// 判定含与两版一致的规范化（取 `/`、`:` 之后的尾段 + `-`→`_` + 小写）。
pub fn is_interaction_tool(tool: &str) -> bool {
    let normalized = tool
        .rsplit(['/', ':'])
        .next()
        .unwrap_or(tool)
        .replace('-', "_")
        .to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "request_user_input"
            | "ask_user"
            | "ask_user_input"
            | "askuserquestion"
            | "ask_user_question"
            | "ask_question"
            | "ask_choice"
            | "choice_question"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// v1 快照用例 → v2（v0.9.0 需求4）：模糊项删除 + FileDelete 激活。
    #[test]
    fn classify_name_matches_v2_rules() {
        // file_read：精确表（v2 收紧：contains("read") 已删，read_file/view_image 收编精确）
        for name in [
            "read",
            "view_file",
            "view",
            "read_file",
            "view_image",
            "Read",
        ] {
            assert_eq!(classify_name(name), ToolViewKind::FileRead, "{name}");
        }
        // v2 收紧回归锁：含 read 的未知名不再模糊命中
        for name in ["ctx_read", "thread_read"] {
            assert_eq!(classify_name(name), ToolViewKind::Other, "{name}");
        }
        // file_delete（v2 激活）
        for name in ["file_delete", "delete_file", "remove_file"] {
            assert_eq!(classify_name(name), ToolViewKind::FileDelete, "{name}");
        }
        // file_edit：第一批 + apply_patch 家族
        for name in [
            "edit",
            "multiedit",
            "str_replace",
            "patch",
            "replace",
            "edit_file",
            "modify_file",
            "file_edit",
            "apply_patch",
            "apply_changes",
        ] {
            assert_eq!(classify_name(name), ToolViewKind::FileEdit, "{name}");
        }
        // file_write
        for name in ["write", "create_file", "write_file", "file_write"] {
            assert_eq!(classify_name(name), ToolViewKind::FileWrite, "{name}");
        }
        // shell_exec（powershell：v0.9.1 需求3 #3 pi 可选原生 PowerShell 工具）
        for name in [
            "bash",
            "shell",
            "exec",
            "execute_command",
            "run_shell_command",
            "powershell",
        ] {
            assert_eq!(classify_name(name), ToolViewKind::ShellExec, "{name}");
        }
        // search（两批）
        for name in [
            "grep",
            "search_files",
            "ripgrep",
            "grep_search",
            "glob",
            "find_files",
            "list_files",
            "list_directory",
        ] {
            assert_eq!(classify_name(name), ToolViewKind::Search, "{name}");
        }
        // web（两批）
        for name in [
            "webfetch",
            "fetch",
            "web_fetch",
            "websearch",
            "web_search",
            "google_web_search",
        ] {
            assert_eq!(classify_name(name), ToolViewKind::Web, "{name}");
        }
        // subtask：精确 + 前缀 + invoke_agent
        for name in ["task", "subagent_researcher", "invoke_agent"] {
            assert_eq!(classify_name(name), ToolViewKind::Subtask, "{name}");
        }
        // think：含 update_topic
        for name in ["thinking", "think", "update_topic"] {
            assert_eq!(classify_name(name), ToolViewKind::Think, "{name}");
        }
        // other：未知与大小写规范化
        assert_eq!(classify_name("unknown_tool"), ToolViewKind::Other);
        assert_eq!(
            classify_name("Bash".to_lowercase().as_str()),
            ToolViewKind::ShellExec
        );
        // v2 收紧边界：含 "read" 子串的未知名不再误判（v1 模糊项活证据：
        // "thread" 含子串 "read" 曾被分类为 file_read）
        assert_eq!(classify_name("reading_notes"), ToolViewKind::Other);
        assert_eq!(classify_name("thread"), ToolViewKind::Other);
    }

    #[test]
    fn extract_locations_common_keys_and_missing() {
        // 四键依序命中，取第一个
        assert_eq!(
            extract_locations(&json!({"path": "b.rs"})),
            vec![ViewLocation {
                path: "b.rs".into(),
                line: None
            }]
        );
        assert_eq!(
            extract_locations(&json!({"file_path": "a.ts", "line": 12})),
            vec![ViewLocation {
                path: "a.ts".into(),
                line: Some(12)
            }]
        );
        assert_eq!(
            extract_locations(&json!({"filename": "c.md", "line_number": "x"})),
            vec![ViewLocation {
                path: "c.md".into(),
                line: None
            }]
        );
        assert!(extract_locations(&json!({"notebook_path": ""})).is_empty());
        // 非对象 / 缺全部键 / 值非字符串
        assert!(extract_locations(&json!("str")).is_empty());
        assert!(extract_locations(&json!({"command": ["ls"]})).is_empty());
        assert!(extract_locations(&json!({"path": 42})).is_empty());
    }

    #[test]
    fn interaction_tool_union_list() {
        // 前端 8 名单全集
        for name in [
            "request_user_input",
            "ask_user",
            "ask_user_input",
            "askuserquestion",
            "ask_user_question",
            "ask_question",
            "ask_choice",
            "choice_question",
        ] {
            assert!(is_interaction_tool(name), "{name}");
        }
        // 后端原 3 名单（并集子集）
        assert!(is_interaction_tool("AskUserQuestion"));
        assert!(is_interaction_tool("tools:ask_question"));
        assert!(is_interaction_tool("mcp/server/ask-user"));
        // 非交互
        assert!(!is_interaction_tool("bash"));
        assert!(!is_interaction_tool("read"));
    }

    #[test]
    fn classify_tool_view_combines() {
        let view = classify_tool_view("Write", &json!({"file_path": "novel.md"}));
        assert_eq!(view.kind, ToolViewKind::FileWrite);
        assert_eq!(view.locations.len(), 1);
        assert_eq!(view.locations[0].path, "novel.md");
    }

    /// v2 per-agent 入口（v0.9.0 需求4）：覆写表（当前空）未命中回落全局，
    /// 位置提取行为不变。
    #[test]
    fn classify_name_for_falls_back_to_global() {
        assert_eq!(classify_name_for("codex", "bash"), ToolViewKind::ShellExec);
        assert_eq!(
            classify_name_for("unknown-agent", "read"),
            ToolViewKind::FileRead
        );
        assert_eq!(
            classify_name_for("codex", "custom_thing"),
            ToolViewKind::Other
        );
        let view = classify_tool_view_for("codex", "file_delete", &json!({"path": "a.txt"}));
        assert_eq!(view.kind, ToolViewKind::FileDelete);
        assert_eq!(view.locations[0].path, "a.txt");
    }
}
