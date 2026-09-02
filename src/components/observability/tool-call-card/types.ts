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

/** v0.9.0 需求4：分类唯一权威在 Rust tool_view.rs（v2）——事件/持久化块
 * 携带渲染意图 view；view 缺失（v1 之前的旧块）按 other 渲染（版本级
 * 「无旧数据兼容」裁决，名称分类 fallback classifyToolName 已删除）。 */
const VALID_KINDS: ReadonlySet<string> = new Set([
  "file_read", "file_write", "file_edit", "file_delete",
  "shell_exec", "search", "web", "think", "subtask", "other",
]);

export function resolveToolKind(_name: string, view?: import("@/types").ToolView): ToolKind {
  const kind = view?.kind;
  // wire 来源的 kind 不可全信（旧版本/异常数据）——非法值回退 other。
  if (typeof kind === "string" && VALID_KINDS.has(kind)) return kind as ToolKind;
  return "other";
}
