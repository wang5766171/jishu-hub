/**
 * task-workspace 类型定义。
 *
 * 设计依据：`docs/task-exec-dev/02-总体设计.md` §3.3 状态模型。
 *
 * T8 减法重构后，任务模式的状态由 chat-page 的 `taskModeActive` + `taskSelectedNodeId`
 * 直接承载（任务模式 = 会话页 + TaskSidebar），T1 阶段设计的 WorkspaceTarget /
 * TaskWorkspaceState / DEFAULT_WORKSPACE_STATE 从未被启用，已随重构删除。
 * 本文件现在只保留后端命令返回值的结构定义。
 */

/**
 * 节点会话摘要（后端 `orchestrator_list_node_sessions` 返回值）。
 *
 * 对应 Rust 侧 `NodeSessionSummary`（domain/run.rs）。
 */
export interface NodeSessionSummary {
  node_id: string;
  node_run_id: string;
  /** NodeRunStatus 字符串（pending / running / succeeded / failed …）。 */
  status: string;
  /** 最新 attempt 的 session_id（可能为空——节点尚未运行或未产生会话）。 */
  session_id: string | null;
  /** 最新 attempt 的 agent 归属（可能为空）。 */
  agent_id: string | null;
  /** 最新 attempt 序号（无 attempt 时为 0）。 */
  attempt_number: number;
  /** 节点中文标题（后端直接返回，来自 run 执行所用 revision，回退 graph current_draft_revision）。 */
  title?: string;
}

/**
 * 派发记录（后端 `orchestrator_list_attempt_dispatches` 返回值）。
 *
 * 用于三角色识别（T6）：把节点会话里的"主进程派发 prompt"与 user turn 做指纹匹配。
 * 字段名严格对齐 Rust `AttemptDispatch`（domain/run.rs），serde 无 rename。
 */
export interface AttemptDispatch {
  attempt_number: number;
  /** 派发时刻（epoch 毫秒/秒，由后端约定；备选锚点用）。 */
  dispatched_at: number;
  /** 派发 prompt 文本（经 agent_prompt_with_policy 包装后的完整文本）。 */
  prompt: string;
}
