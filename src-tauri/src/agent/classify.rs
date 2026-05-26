use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
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

pub fn classify_tool_call(tool_name: &str, _input: &serde_json::Value) -> ToolKind {
    let name = tool_name.to_lowercase();
    if name == "read" || name == "view_file" || name == "view" || name.contains("read") {
        return ToolKind::FileRead;
    }
    if name == "edit" || name == "multiedit" || name == "str_replace" || name == "patch" {
        return ToolKind::FileEdit;
    }
    if name == "write" || name == "create_file" {
        return ToolKind::FileWrite;
    }
    if name == "apply_patch" || name == "apply_changes" {
        return ToolKind::FileEdit;
    }
    if name == "bash" || name == "shell" || name == "exec" || name == "execute_command" {
        return ToolKind::ShellExec;
    }
    if name == "grep" || name == "search_files" || name == "ripgrep" {
        return ToolKind::Search;
    }
    if name == "glob" || name == "find_files" || name == "list_files" {
        return ToolKind::Search;
    }
    if name == "webfetch" || name == "fetch" || name == "web_fetch" {
        return ToolKind::Web;
    }
    if name == "websearch" || name == "web_search" {
        return ToolKind::Web;
    }
    if name == "task" || name == "dispatch_subagent" || name.starts_with("subagent_") {
        return ToolKind::Subtask;
    }
    if name == "thinking" {
        return ToolKind::Think;
    }
    ToolKind::Other
}
