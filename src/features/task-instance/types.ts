/**
 * TaskInstance 前端类型定义（v0.9.7 需求2 去阶段化）。
 *
 * 与后端 task_launch 的 TaskLaunchInstance 1:1 映射（schema v4）：
 * - 阶段字段（current_phase/requirement_file/requirement_session_id/
 *   planning_session_id）退场，合并为 task_session_id（单对话流）；
 * - stages_json 语义改为 runner 步骤清单
 *   （`{steps:[{id,title,status:"todo"|"running"|"done"|"failed"}],pendingQuestion?}`），
 *   任务卡（状态灯）的数据源。
 */
export const JISHU_SELF_AGENT_ID = "jishu-self";

/** `planner_agent_id` 的历史遗留别名（下划线），来自 SQL 列默认值。 */
export const LEGACY_JISHU_AGENT_ALIAS = "jishu_agent";

export function normalizeAgentId(raw: string | null | undefined): string {
  if (!raw) return JISHU_SELF_AGENT_ID;
  return raw === LEGACY_JISHU_AGENT_ALIAS ? JISHU_SELF_AGENT_ID : raw;
}

/** runner 步骤（任务卡状态灯）。 */
export interface RunnerStep {
  id: string;
  title: string;
  status: "todo" | "running" | "done" | "failed";
}

/** runner 步骤清单载荷（stages_json 解析形态）。 */
export interface RunnerCard {
  steps: RunnerStep[];
  pendingQuestion?: { question: string; options?: string[] } | null;
}

/** 解析 stages_json（损坏/缺省 → 空清单）。 */
export function parseRunnerCard(stagesJson: string | null | undefined): RunnerCard {
  if (!stagesJson) return { steps: [], pendingQuestion: null };
  try {
    const parsed = JSON.parse(stagesJson) as Partial<RunnerCard>;
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.filter(
          (s): s is RunnerStep =>
            !!s && typeof s.id === "string" && typeof s.title === "string",
        )
      : [];
    return { steps, pendingQuestion: parsed.pendingQuestion ?? null };
  } catch {
    return { steps: [], pendingQuestion: null };
  }
}

/**
 * 任务实例摘要（与后端 TaskLaunchInstance 1:1 映射）。
 */
export interface TaskLaunchInstanceSummary {
  task_id: string;
  project_root: string;
  title: string;
  skill_id: string;
  planner_agent_id?: string;
  status: string;
  task_session_id?: string | null;
  graph_id?: string | null;
  active_run_id?: string | null;
  last_run_id?: string | null;
  run_status?: string | null;
  stages_json?: string | null;
  created_at: number;
  updated_at: number;
}

/** TaskInstance 生命周期状态（v0.9.7 收敛为 active|archived）。 */
export type TaskInstanceStatus = "active" | "archived";

/** 执行实例运行态（5 值，冗余到 task_instance.run_status）。 */
export type TaskRunStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** 执行会话范围。 */
export type ExecutionChatScope =
  | { kind: "run" }
  | { kind: "node"; nodeId: string; attemptNumber: number };

/** 与后端 TaskLaunchInstance 1:1 映射。 */
export interface TaskInstance {
  task_id: string;
  project_root: string;
  title: string;
  skill_id: string;
  planner_agent_id: string;
  status: TaskInstanceStatus;
  task_session_id: string | null;
  graph_id: string | null;
  active_run_id: string | null;
  last_run_id: string | null;
  run_status: TaskRunStatus | null;
  stages_json: string | null;
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
  task_session_id?: string | null;
  graph_id?: string | null;
  active_run_id?: string | null;
  last_run_id?: string | null;
  run_status?: string | null;
  stages_json?: string | null;
  created_at: number;
  updated_at: number;
}

/** 节点会话信息（节点子代理会话缓存，来自 useNodeSession）。 */
export interface NodeSessionInfo {
  node_id: string;
  node_run_id: string;
  attempt_number: number;
  session_id: string | null;
  status: string;
  agent_id: string | null;
}

// ── Raw → Instance 转换 ──

/** 后端 status 字符串 → 强类型（未知值兜底 active）。 */
export function normalizeStatus(raw: string): TaskInstanceStatus {
  return raw === "archived" ? "archived" : "active";
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
    task_session_id: raw.task_session_id ?? null,
    graph_id: raw.graph_id ?? null,
    active_run_id: raw.active_run_id ?? null,
    last_run_id: raw.last_run_id ?? null,
    run_status: normalizeRunStatus(raw.run_status),
    stages_json: raw.stages_json ?? null,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

/** 任务是否已完成（run_status 口径——无 phase 派生）。 */
export function isTaskCompleted(instance: TaskInstance | null): boolean {
  if (!instance) return false;
  return instance.run_status === "completed";
}
