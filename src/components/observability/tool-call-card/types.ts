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
  /** v0.8.0 需求2 Phase 1：事件/持久化块携带的渲染意图（优先于名称分类）。 */
  view?: import("@/types").ToolView;
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

/** v0.8.0 需求2 Phase 1：优先用事件携带的渲染意图；缺失（v1 之前的
 * 持久化块/旧版本事件）回退名称分类。分类唯一权威在 Rust tool_view.rs，
 * classifyToolName 仅为历史数据 fallback。 */
const VALID_KINDS: ReadonlySet<string> = new Set([
  "file_read", "file_write", "file_edit", "file_delete",
  "shell_exec", "search", "web", "think", "subtask", "other",
]);

export function resolveToolKind(name: string, view?: import("@/types").ToolView): ToolKind {
  const kind = view?.kind;
  // wire 来源的 kind 不可全信（旧版本/异常数据）——非法值回退名称分类。
  if (typeof kind === "string" && VALID_KINDS.has(kind)) return kind as ToolKind;
  return classifyToolName(name);
}

export function classifyToolName(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n === "read" || n === "view_file" || n === "view" || n.includes("read")) return "file_read";
  if (n === "edit" || n === "multiedit" || n === "str_replace" || n === "patch" || n === "replace" || n === "edit_file" || n === "modify_file" || n === "file_edit") return "file_edit";
  if (n === "write" || n === "create_file" || n === "write_file" || n === "file_write") return "file_write";
  if (n === "apply_patch" || n === "apply_changes") return "file_edit";
  if (n === "bash" || n === "shell" || n === "exec" || n === "execute_command" || n === "run_shell_command") return "shell_exec";
  if (n === "grep" || n === "search_files" || n === "ripgrep" || n === "grep_search") return "search";
  if (n === "glob" || n === "find_files" || n === "list_files" || n === "list_directory") return "search";
  if (n === "webfetch" || n === "fetch" || n === "web_fetch") return "web";
  if (n === "websearch" || n === "web_search" || n === "google_web_search") return "web";
  if (n === "task" || n.startsWith("subagent_") || n === "invoke_agent") return "subtask";
  if (n === "thinking" || n === "think" || n === "update_topic") return "think";
  return "other";
}
