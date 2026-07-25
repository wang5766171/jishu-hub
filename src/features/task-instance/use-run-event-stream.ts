/**
 * useRunEventStream —— 执行阶段主任务会话 hook。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §2.3.1、§11 第 7/9 条。
 *           `任务数据结构与生命周期设计_20260622.md` §3.3.1。
 *
 * 主任务会话是 task_event 按 run_seq 投影的"虚拟会话"，不对应真实 session_id。
 * 它与 useChatSession 数据层分离（数据源不同），但渲染层复用同一个 MessageView。
 *
 * 约束（§4.6.1）：进入执行阶段即挂载、始终活跃（承载画布节点状态/主进程实时态）；
 * 与"当前选中节点的 useChatSession"并存，切换 chatScope 不影响本 hook 的轮询。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import type { Message } from "@/types";
import type { RunProjection, TaskEvent, RunStatusValue } from "@/features/task-instance/graph/use-task-graph";
import { normalizeRunStatusValue } from "@/features/task-instance/graph/use-task-graph";

export interface RunEventStreamState {
  /** 投影后的消息列表（按 run_seq 顺序，喂给 MessageView）。 */
  projectedMessages: Message[];
  /** 最近一次轮询的 run_seq 游标。 */
  cursor: number;
  /** 是否正在轮询。 */
  polling: boolean;
  /** 运行状态（来自 RunProjection，后端 snake_case 契约）。 */
  runStatus: RunStatusValue | null;
  /** 错误信息。 */
  error: string | null;
}

export interface UseRunEventStreamOptions {
  /** 当前活跃 run id（null 时不轮询）。 */
  runId: string | null;
  /** 轮询间隔 ms，默认 1000。 */
  pollIntervalMs?: number;
}

/** 将 task_event 投影为 Message（简化版：每条事件 → 一条 assistant 消息片段）。
 *
 *  实际渲染时由 MessageView 按 content block 展示。这里只做"事件 → 消息结构"的归一化。
 */
function eventToMessage(event: TaskEvent, t: TFunction): Message | null {
  const payload = event.payload ?? {};
  const text = describeEvent(event.event_type, payload, t);
  if (!text) return null;
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: event.occurred_at,
  };
}

/** 将事件类型 + payload 描述为可读文本。
 *
 * ⚠️ 事件名必须与后端 `TaskEventType`（`orchestrator/events/mod.rs:26-61`，带
 * `#[serde(rename_all = "snake_case")]`）逐字一致。历史坑：此前匹配
 * `node_started`/`node_succeeded`/`node_failed`/`interaction_request` —— 这四个名字
 * 在枚举中**根本不存在**，导致节点级进度全部静默丢弃，只剩审批/run 收尾三种可见，
 * 用户误判"执行没动"。真实名称为 attempt_started / node_resolved / attempt_failed。
 *
 * payload 字段同样以后端 `payloads` 模块为准：节点级事件只带 `node_run_id`/`node_id`，
 * **不含节点标题**；`attempt_failed` 的 `error` 是 `AttemptError` 结构体（取 `.message`）。
 */
function describeEvent(
  eventType: string,
  payload: Record<string, unknown>,
  t: TFunction,
): string {
  /** 取节点可读标识：优先 node_id，回退 node_run_id。 */
  const nodeLabel = (): string => {
    const nodeId = payload.node_id;
    if (typeof nodeId === "string" && nodeId) return nodeId;
    const nodeRunId = payload.node_run_id;
    return typeof nodeRunId === "string" ? nodeRunId : "";
  };

  switch (eventType) {
    case "run_started":
      return `● ${t("task.event.runStarted", "运行开始")}`;
    case "node_ready":
      return `○ ${t("task.event.nodeReady", "节点就绪")}：${nodeLabel()}`;
    case "attempt_started": {
      const attemptNumber = payload.attempt_number;
      const suffix =
        typeof attemptNumber === "number" && attemptNumber > 1
          ? `（${t("task.event.attemptNumber", "第 {{n}} 次尝试", { n: attemptNumber })}）`
          : "";
      return `▶ ${t("task.event.nodeStarted", "节点开始")}：${nodeLabel()}${suffix}`;
    }
    case "node_resolved": {
      const finalStatus = payload.final_status;
      const status = typeof finalStatus === "string" ? finalStatus : "";
      const icon = status === "succeeded" ? "✓" : status === "failed" ? "✗" : "•";
      const statusLabel = status
        ? `（${t(`task.nodeStatus.${status}`, status)}）`
        : "";
      return `${icon} ${t("task.event.nodeResolved", "节点结束")}：${nodeLabel()}${statusLabel}`;
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
      return `✗ ${t("task.event.attemptFailed", "尝试失败")}：${nodeLabel()}${message ? `（${message}）` : ""}`;
    }
    case "retry_scheduled": {
      const next = payload.next_attempt_number;
      const suffix =
        typeof next === "number"
          ? `（${t("task.event.attemptNumber", "第 {{n}} 次尝试", { n: next })}）`
          : "";
      return `↻ ${t("task.event.retryScheduled", "已安排重试")}：${nodeLabel()}${suffix}`;
    }
    case "node_skipped":
      return `⤼ ${t("task.event.nodeSkipped", "节点跳过")}：${nodeLabel()}`;
    case "node_blocked":
      return `⛔ ${t("task.event.nodeBlocked", "节点阻塞")}：${nodeLabel()}`;
    case "approval_requested": {
      const desc =
        typeof payload.description === "string" && payload.description
          ? payload.description
          : t("task.event.approvalNeeded", "需要审批");
      return `⚠ ${t("task.event.approvalRequested", "审批请求")}：${desc}`;
    }
    case "approval_resolved": {
      const approved = payload.approved === true;
      const verdict = approved
        ? t("task.event.approvalApproved", "通过")
        : t("task.event.approvalRejected", "驳回");
      return `${approved ? "✓" : "✗"} ${t("task.event.approvalResolved", "审批")}${verdict}：${nodeLabel()}`;
    }
    case "budget_exceeded": {
      const budgetType = typeof payload.budget_type === "string" ? payload.budget_type : "";
      return `⚠ ${t("task.event.budgetExceeded", "预算超限")}${budgetType ? `：${budgetType}` : ""}`;
    }
    case "run_paused":
      return `⏸ ${t("task.event.runPaused", "运行已暂停")}`;
    case "run_resumed":
      return `▶ ${t("task.event.runResumed", "运行已恢复")}`;
    case "run_cancelled":
      return `● ${t("task.event.runCancelled", "运行已取消")}`;
    case "run_completed":
      return `● ${t("task.event.runCompleted", "运行完成")}`;
    case "run_failed":
      return `● ${t("task.event.runFailed", "运行失败")}`;
    default:
      // Q2（用户 2026-07-25 定）：显示兜底而非静默忽略——本次 bug 正因静默丢弃而长期隐藏。
      return `· ${eventType}`;
  }
}

export function useRunEventStream(options: UseRunEventStreamOptions): RunEventStreamState {
  const { runId, pollIntervalMs = 1000 } = options;
  const { t } = useTranslation();

  const [projectedMessages, setProjectedMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState(0);
  const [polling, setPolling] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatusValue | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 用 ref 持有 t：poll 的 useCallback 依赖保持为 []，避免语言对象变化重建 poll
  // 进而重置轮询定时器（见下方 useEffect 依赖 poll）。
  const tRef = useRef(t);
  tRef.current = t;

  const cursorRef = useRef(0);
  const runIdRef = useRef<string | null>(runId);
  const seenEventIdsRef = useRef<Set<string>>(new Set());

  // runId 变化 → 重置游标与消息。
  useEffect(() => {
    runIdRef.current = runId;
    cursorRef.current = 0;
    setCursor(0);
    setProjectedMessages([]);
    setRunStatus(null);
    setError(null);
    seenEventIdsRef.current = new Set();
  }, [runId]);

  const poll = useCallback(async () => {
    const currentRunId = runIdRef.current;
    if (!currentRunId) return;
    setPolling(true);
    try {
      // 1. 拉取增量事件
      const events = await invokeCommand<TaskEvent[]>("orchestrator_run_events_after", {
        runId: currentRunId,
        afterSeq: cursorRef.current,
      });
      if (events && events.length > 0) {
        // 去重（按 event_id）+ 按 run_seq 排序
        const unseen = events
          .filter((e) => !seenEventIdsRef.current.has(e.event_id))
          .sort((a, b) => a.run_seq - b.run_seq);
        for (const e of unseen) seenEventIdsRef.current.add(e.event_id);
        const newMessages = unseen
          .map((e) => eventToMessage(e, tRef.current))
          .filter((m): m is Message => m !== null);
        if (newMessages.length > 0) {
          setProjectedMessages((prev) => [...prev, ...newMessages]);
        }
        const maxSeq = unseen[unseen.length - 1].run_seq;
        cursorRef.current = maxSeq;
        setCursor(maxSeq);
      }

      // 2. 刷新 run 状态
      const projection = await invokeCommand<RunProjection>(
        "orchestrator_get_run_projection",
        { runId: currentRunId },
      );
      if (projection) {
        setRunStatus(normalizeRunStatusValue(projection.status));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setPolling(false);
    }
  }, []);

  // 轮询：runId 存在且非终态时每 pollIntervalMs 轮询一次。
  useEffect(() => {
    if (!runId) return;
    // 立即拉一次
    poll().catch(console.error);
    const timer = setInterval(() => {
      poll().catch(console.error);
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [runId, pollIntervalMs, poll]);

  return {
    projectedMessages,
    cursor,
    polling,
    runStatus,
    error,
  };
}
