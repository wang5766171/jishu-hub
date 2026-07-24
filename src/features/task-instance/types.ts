/**
 * TaskInstance 前端类型定义。
 *
 * 设计依据：`任务数据结构与生命周期设计_20260622.md` §1.1、§1.2、§2、§3.3.1、§1.3。
 * 与后端 task_launch.rs 的 TaskLaunchInstance 1:1 映射。
 */
/** 三阶段生命周期（后端 canonical）。 */
export type TaskPhase = "requirements" | "planning" | "execution";

/** TaskInstance 生命周期状态（4 值，持久化到 task_instance.status）。 */
export type TaskInstanceStatus =
  | "requirements_discussing"
  | "requirements_finalized"
  | "planning_discussing"
  | "graph_created";

/** 执行实例运行态（5 值，冗余到 task_instance.run_status）。 */
export type TaskRunStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** 执行阶段会话范围（三层模型 §3.3.1）。 */
export type ExecutionChatScope =
  | { kind: "run" } // 主任务会话（task_event 投影，无真实 session_id）
  | { kind: "node"; nodeId: string; attemptNumber: number }; // 子代理会话

/** 执行阶段展现形式（与 chatScope 正交）。 */
export type ExecutionView = "canvas" | "split" | "chat";

/** 阶段显示状态（导航条 done/active/pending）。 */
export type PhaseDisplayState = "done" | "active" | "pending";

/** 与后端 TaskLaunchInstance 1:1 映射。 */
export interface TaskInstance {
  task_id: string;
  project_root: string;
  title: string;
  skill_id: string;
  /** 需求/规划阶段使用的 agent（默认 "jishu_agent"）。 */
  planner_agent_id: string;
  status: TaskInstanceStatus;
  current_phase: TaskPhase;
  requirement_file: string | null;
  requirement_session_id: string | null;
  planning_session_id: string | null;
  graph_id: string | null;
  /** 当前活跃执行实例。 */
  active_run_id: string | null;
  /** 最近一次执行实例。 */
  last_run_id: string | null;
  /** 执行状态冗余（仅执行阶段有值）。 */
  run_status: TaskRunStatus | null;
  created_at: number;
  updated_at: number;
}

/** 后端原始返回（可选字段用 ? 标记，前端转换）。 */
export interface TaskInstanceRaw {
  task_id: string;
  project_root: string;
  title: string;
  skill_id: string;
  planner_agent_id: string;
  status: string;
  current_phase: string;
  requirement_file?: string | null;
  requirement_session_id?: string | null;
  planning_session_id?: string | null;
  graph_id?: string | null;
  active_run_id?: string | null;
  last_run_id?: string | null;
  run_status?: string | null;
  created_at: number;
  updated_at: number;
}

/** 需求定稿请求（对应后端 RequirementFinalizeRequest）。 */
export interface RequirementFinalizeRequest {
  task_id: string | null;
  skill_id: string;
  title: string | null;
  /** 终稿 markdown 内容（Agent 按 skill 约束产出，或用户直接描述）。 */
  requirement_markdown: string;
  source_session_id: string | null;
  creation_mode: "discussion" | "direct";
}

/** 需求定稿响应。 */
export interface TaskRequirementFinalized {
  task_id: string;
  title: string;
  requirement_dir: string;
  requirement_file: string;
  planning_instruction: string;
}

/** 任务会话索引项。 */
export interface TaskSessionEntry {
  phase: TaskPhase;
  session_id: string;
  session_type: "requirement" | "planning" | "node_execution";
  node_id?: string;
  agent_id?: string | null;
}

/** 任务会话索引。 */
export interface TaskSessionIndex {
  task_id: string;
  entries: TaskSessionEntry[];
}

/** 节点会话信息（执行阶段节点子代理会话缓存，来自 useNodeSession）。 */
export interface NodeSessionInfo {
  node_id: string;
  node_run_id: string;
  attempt_number: number; // 从 0 开始
  session_id: string | null; // Agent 原生会话 ID（用于 get_session_messages）
  status: string;
  agent_id: string | null;
}

// ── Raw → Instance 转换 ──

/** 后端 current_phase 归一化（消除旧 "graph" 别名，统一为 "execution"）。 */
export function normalizeBackendPhase(raw: string): TaskPhase {
  switch (raw) {
    case "planning":
      return "planning";
    case "execution":
    case "graph":
      return "execution";
    default:
      return "requirements";
  }
}

/** 后端 status 字符串 → 强类型（未知值兜底为 requirements_discussing）。 */
export function normalizeStatus(raw: string): TaskInstanceStatus {
  switch (raw) {
    case "requirements_discussing":
    case "requirements_finalized":
    case "planning_discussing":
    case "graph_created":
      return raw;
    default:
      return "requirements_discussing";
  }
}

/** 后端 run_status 字符串 → 强类型。 */
export function normalizeRunStatus(raw: string | null | undefined): TaskRunStatus | null {
  if (!raw) return null;
  switch (raw) {
    case "running":
    case "paused":
    case "completed":
    case "failed":
    case "cancelled":
      return raw;
    default:
      return null;
  }
}

/** Raw → Instance 转换。 */
export function taskInstanceFromRaw(raw: TaskInstanceRaw): TaskInstance {
  return {
    task_id: raw.task_id,
    project_root: raw.project_root,
    title: raw.title,
    skill_id: raw.skill_id,
    planner_agent_id: raw.planner_agent_id,
    status: normalizeStatus(raw.status),
    current_phase: normalizeBackendPhase(raw.current_phase),
    requirement_file: raw.requirement_file ?? null,
    requirement_session_id: raw.requirement_session_id ?? null,
    planning_session_id: raw.planning_session_id ?? null,
    graph_id: raw.graph_id ?? null,
    active_run_id: raw.active_run_id ?? null,
    last_run_id: raw.last_run_id ?? null,
    run_status: normalizeRunStatus(raw.run_status),
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

/**
 * PhaseDisplayState 派生规则（§2.4）。
 *
 * requirements: active=current; planning/execution → done
 * planning: active=planning; execution → done; requirements + requirement_file → done(直接生成); 否则 pending
 * execution: active=execution; 否则 pending
 */
export function derivePhaseDisplayState(
  phase: TaskPhase,
  instance: TaskInstance | null,
): PhaseDisplayState {
  if (!instance) return "pending";
  const current = instance.current_phase;
  const order: TaskPhase[] = ["requirements", "planning", "execution"];
  const currentIdx = order.indexOf(current);
  const phaseIdx = order.indexOf(phase);
  if (phaseIdx < currentIdx) return "done";
  if (phaseIdx > currentIdx) {
    // 直接生成模式：planning 阶段在 requirements 期但已有终稿 → done
    if (phase === "planning" && instance.requirement_file) return "done";
    return "pending";
  }
  return "active";
}

/** 三阶段显示状态集合。 */
export type PhaseDisplayStates = Record<TaskPhase, PhaseDisplayState>;

export function deriveAllPhaseStates(instance: TaskInstance | null): PhaseDisplayStates {
  return {
    requirements: derivePhaseDisplayState("requirements", instance),
    planning: derivePhaseDisplayState("planning", instance),
    execution: derivePhaseDisplayState("execution", instance),
  };
}
