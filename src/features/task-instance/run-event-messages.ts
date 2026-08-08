/**
 * run-event-messages —— 主任务会话的「事件 → 消息」投影。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §2.3.1、§11 第 7/9 条。
 *           `任务数据结构与生命周期设计_20260622.md` §3.3.1。
 *
 * 主任务会话是 task_event 按 run_seq 投影的"虚拟会话"，不对应真实 session_id。
 * 它与 useChatSession 数据层分离（数据源不同），但渲染层复用同一个 MessageView。
 *
 * F1（2026-07-30）：从已下线的 useRunEventStream 迁入本模块，事件源改为
 * useTaskGraph 统一轮询维护的 events（planPoll 增量），本模块只做纯投影。
 *
 * T8-P1b（2026-08-02）：投影语言从"机器事件态"（运行开始/节点就绪/审批请求）改写为
 * **主对话第一人称口吻**——点击「开始执行」即视为主对话在驱动流程：逐节点驱动、监控执行、
 * 收尾统一汇总。配合 useTaskGraph 的自动审批（去掉人工审批卡点），呈现"主对话驱动流程"的叙事。
 * 不再显示审批类事件（审批已由前端自动通过）。
 */
import type { TFunction } from "i18next";
import type { Message } from "@/types";
import type { TaskEvent } from "@/features/task-instance/graph/use-task-graph";

/** 投影上下文：节点总数（run_started 播报）、汇总计数（run_completed 播报）。 */
export interface EventProjectionCtx {
  nodeCount?: number;
  summary?: { succeeded: number; failed: number };
}

/** 将 task_event 投影为 Message（主对话口吻的 assistant 片段）。
 *
 * 节点可读标识优先取 snapshot 中的节点标题（nodeTitles），回退 node_id / node_run_id。
 */
export function eventToMessage(
  event: TaskEvent,
  t: TFunction,
  nodeTitles?: Map<string, string>,
  ctx?: EventProjectionCtx,
): Message | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const text = describeEvent(event.event_type, payload, t, nodeTitles, ctx);
  if (!text) return null;
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: event.occurred_at,
  };
}

/**
 * 将事件类型 + payload 描述为可读文本（主对话第一人称）。
 *
 * ⚠️ 事件名必须与后端 `TaskEventType`（`orchestrator/events/mod.rs:26-61`，带
 * `#[serde(rename_all = "snake_case")]`）逐字一致。历史坑：此前匹配
 * `node_started`/`node_succeeded`/`node_failed`/`interaction_request` —— 这四个名字
 * 在枚举中**根本不存在**，导致节点级进度全部静默丢弃。真实名称为 attempt_started /
 * node_resolved / attempt_failed。
 *
 * payload 字段同样以后端 `payloads` 模块为准：节点级事件只带 `node_run_id`/`node_id`，
 * **不含节点标题**；标题由调用方通过 nodeTitles 传入。`attempt_failed` 的 `error` 是
 * `AttemptError` 结构体（取 `.message`）。
 */
function describeEvent(
  eventType: string,
  payload: Record<string, unknown>,
  t: TFunction,
  nodeTitles?: Map<string, string>,
  ctx?: EventProjectionCtx,
): string | null {
  /** 取节点可读标识：优先节点标题，回退 node_id，再回退 node_run_id。
   * 注意：attempt_started 等事件的 payload 只带 node_run_id（无 node_id，见 events/mod.rs），
   * 因此 node_run_id 也必须查 nodeTitles，否则会裸显 nr_xxx。 */
  const nodeLabel = (): string => {
    const nodeId = payload.node_id;
    if (typeof nodeId === "string" && nodeId) {
      const title = nodeTitles?.get(nodeId);
      if (title) return title;
      return nodeId;
    }
    const nodeRunId = payload.node_run_id;
    if (typeof nodeRunId === "string" && nodeRunId) {
      const title = nodeTitles?.get(nodeRunId);
      if (title) return title;
      return nodeRunId;
    }
    return "";
  };

  switch (eventType) {
    case "run_started": {
      const count = ctx?.nodeCount ?? 0;
      return t("task.event.runStarted", "我已经开始执行这个流程（共 {{count}} 个步骤），会逐个驱动并监控每个节点的执行。", { count });
    }
    case "node_ready":
      return t("task.event.nodeReady", "📋 准备执行：{{label}}", { label: nodeLabel() });
    case "attempt_started": {
      const attemptNumber = payload.attempt_number;
      const suffix =
        typeof attemptNumber === "number" && attemptNumber > 1
          ? `（${t("task.event.attemptNumber", "第 {{n}} 次尝试", { n: attemptNumber })}）`
          : "";
      return t("task.event.nodeStarted", "▶ 正在执行：{{label}}{{suffix}}", { label: nodeLabel(), suffix });
    }
    case "node_resolved": {
      const finalStatus = payload.final_status;
      const status = typeof finalStatus === "string" ? finalStatus : "";
      if (status === "succeeded") {
        return t("task.event.nodeResolvedOk", "✅ {{label}} 已完成", { label: nodeLabel() });
      }
      if (status === "failed") {
        return t("task.event.nodeResolvedFail", "❌ {{label}} 执行失败", { label: nodeLabel() });
      }
      const statusLabel = status ? `（${t(`task.nodeStatus.${status}`, status)}）` : "";
      return t("task.event.nodeResolved", "• {{label}}{{status}}", { label: nodeLabel(), status: statusLabel });
    }
    case "attempt_failed": {
      // error 是 AttemptError { category, message, retryable, ... }
      const error = payload.error;
      let message = "";
      if (error && typeof error === "object" && "message" in error) {
        const raw = (error as { message?: unknown }).message;
        if (typeof raw === "string") message = raw;
      } else if (typeof error === "string") {
        message = error;
      }
      const attemptNumber = payload.attempt_number;
      return t("task.event.attemptFailed", "❌ {{label}} 第 {{n}} 次尝试失败{{message}}", {
        label: nodeLabel(),
        n: typeof attemptNumber === "number" ? attemptNumber : "",
        message: message ? `（${message}）` : "",
      });
    }
    case "retry_scheduled": {
      const next = payload.next_attempt_number;
      const n = typeof next === "number" ? next : "";
      return t("task.event.retryScheduled", "↻ {{label}} 已安排第 {{n}} 次重试", { label: nodeLabel(), n });
    }
    case "node_skipped":
      return t("task.event.nodeSkipped", "⤼ {{label}} 已跳过", { label: nodeLabel() });
    case "node_blocked":
      return t("task.event.nodeBlocked", "⛔ {{label}} 暂被阻塞，将自动重试", { label: nodeLabel() });
    // 审批事件不再投影显示：审批已由前端自动通过（去掉人工审批卡点）。
    case "approval_requested":
      return null;
    case "approval_resolved":
      return null;
    // 底层/基础设施事件：进度心跳、租约、循环控制、内部修复/修订等，对用户叙事零价值，
    // 且 attempt_progressed 单次执行可上百条，全部抑制投影（避免刷屏噪音）。
    // 注意：此处**显式** return null；default 仍保留「· ${eventType}」兜底，确保未来新增事件可见（Q2 反静默丢弃）。
    case "attempt_progressed":
    case "lease_granted":
    case "lease_expired":
    case "loop_sleeping":
    case "loop_started":
    case "loop_completed":
    case "iteration_started":
    case "progress_evaluated":
    case "revision_created":
    case "revision_applied_to_run":
    case "repair_graph_attached":
    case "recovery_chosen":
    case "node_superseded":
    case "artifact_produced":
      return null;
    case "budget_exceeded": {
      const budgetType = typeof payload.budget_type === "string" ? payload.budget_type : "";
      return t("task.event.budgetExceeded", "⚠ 预算超限{{type}}", { type: budgetType ? `：${budgetType}` : "" });
    }
    case "run_paused":
      return t("task.event.runPaused", "⏸ 流程已暂停");
    case "run_resumed":
      return t("task.event.runResumed", "▶ 流程已恢复");
    case "run_cancelled":
      return t("task.event.runCancelled", "● 流程已取消");
    case "run_completed": {
      const summary = ctx?.summary ?? { succeeded: 0, failed: 0 };
      return t("task.event.runCompleted", "🎉 全部步骤执行完成。成功 {{ok}} 个，失败 {{fail}} 个，我已对整体结果做了统一汇总。", {
        ok: summary.succeeded,
        fail: summary.failed,
      });
    }
    case "run_failed":
      return t("task.event.runFailed", "⚠ 流程执行失败，请查看上方各节点执行详情。");
    default:
      // Q2（用户 2026-07-25 定）：显示兜底而非静默忽略——本次 bug 正因静默丢弃而长期隐藏。
      return `· ${eventType}`;
  }
}
