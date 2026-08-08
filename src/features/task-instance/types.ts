/**
 * TaskInstance 前端类型定义。
 *
 * 设计依据：`任务数据结构与生命周期设计_20260622.md` §1.1、§1.2、§2、§3.3.1、§1.3。
 * 与后端 task_launch.rs 的 TaskLaunchInstance 1:1 映射。
 */
/** 三阶段生命周期（后端 canonical）。 */
export type TaskPhase = "requirements" | "planning" | "execution";

/**
 * 内置 jishu agent 的权威 id（与后端 `agent::JISHU_SELF_AGENT_ID` 对齐）。
 *
 * 命名分层：用户可见一律 `Jishu Agent`（走 `display_name`/i18n，**禁止**在 UI 直出本常量，
 * 见 DEVELOP_READ §13.6）；内部标识用本常量。
 */
export const JISHU_SELF_AGENT_ID = "jishu-self";

/** `planner_agent_id` 的历史遗留别名（下划线），来自 SQL 列默认值。 */
export const LEGACY_JISHU_AGENT_ALIAS = "jishu_agent";

/**
 * 把可能来自历史数据的 agent id 归一为 registry 可查的权威 id。
 * 与后端 `agent::normalize_agent_id` 行为一致。
 */
export function normalizeAgentId(raw: string | null | undefined): string {
  if (!raw) return JISHU_SELF_AGENT_ID;
  return raw === LEGACY_JISHU_AGENT_ALIAS ? JISHU_SELF_AGENT_ID : raw;
}

/**
 * 任务实例摘要（与后端 task_launch.rs 的 TaskLaunchInstance 1:1 映射）。
 * 原为 chat-page 局部接口，减法重构后抽出为共享类型，供 TaskSidebar 复用。
 */
export interface TaskLaunchInstanceSummary {
  task_id: string;
  project_root: string;
  title: string;
  skill_id: string;
  planner_agent_id?: string;
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

/** 阶段显示状态（导航条 done/active/pending）。 */
export type PhaseDisplayState = "done" | "active" | "pending";

/** 与后端 TaskLaunchInstance 1:1 映射。 */
export interface TaskInstance {
  task_id: string;
  project_root: string;
  title: string;
  skill_id: string;
  /**
   * 需求/规划阶段使用的 agent，也是执行阶段未锁定节点的默认执行者。
   *
   * ⚠️ 历史数据可能是下划线形式 `jishu_agent`（SQL 列默认值），与 agent registry
   * 的 `jishu-self` 不相等。取用前务必经 {@link normalizeAgentId} 归一化。
   */
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
 * 任务是否已进入完成态。
 *
 * 设计 §11 存在第 4 个语义阶段 done（「已完成任务 phase=done 只读」），但它不是
 * `current_phase` 的取值——后端同样是从 `current_phase == execution && run_status
 * == completed` 派生（`task_launch.rs` 的 phase 派生逻辑），DB 里不存 done。
 * 前端沿用同一派生口径，避免引入第四个 TaskPhase 枚举值而牵动大量 switch。
 */
export function isTaskCompleted(instance: TaskInstance | null): boolean {
  if (!instance) return false;
  return instance.current_phase === "execution" && instance.run_status === "completed";
}

/**
 * PhaseDisplayState 派生规则（§2.4）。
 *
 * requirements: active=current; planning/execution → done
 * planning: active=planning; execution → done; requirements + requirement_file → done(直接生成); 否则 pending
 * execution: active=execution; run 完成后 → done（设计 §11）
 */
export function derivePhaseDisplayState(
  phase: TaskPhase,
  instance: TaskInstance | null,
): PhaseDisplayState {
  if (!instance) return "pending";
  // 完成态：三个阶段全部 done，nav 可只读回溯任意阶段。
  if (isTaskCompleted(instance)) return "done";
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
