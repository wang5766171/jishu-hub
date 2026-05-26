export type ToolStatus = "pending" | "running" | "success" | "error" | "aborted";
export type ToolKind =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "file_delete"
  | "shell_exec"
  | "search"
  | "web"
  | "think"
  | "subtask"
  | "other";

export interface ToolCall {
  id: string;
  toolName: string;
  kind: ToolKind;
  status: ToolStatus;
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export function classifyToolName(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n === "read" || n === "view_file" || n === "view" || n.includes("read")) return "file_read";
  if (n === "edit" || n === "multiedit" || n === "str_replace" || n === "patch") return "file_edit";
  if (n === "write" || n === "create_file") return "file_write";
  if (n === "apply_patch" || n === "apply_changes") return "file_edit";
  if (n === "bash" || n === "shell" || n === "exec" || n === "execute_command") return "shell_exec";
  if (n === "grep" || n === "search_files" || n === "ripgrep") return "search";
  if (n === "glob" || n === "find_files" || n === "list_files") return "search";
  if (n === "webfetch" || n === "fetch" || n === "web_fetch") return "web";
  if (n === "websearch" || n === "web_search") return "web";
  if (n === "task" || n.startsWith("subagent_")) return "subtask";
  if (n === "thinking") return "think";
  return "other";
}
