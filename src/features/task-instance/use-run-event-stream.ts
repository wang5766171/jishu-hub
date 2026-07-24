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
import { invokeCommand } from "@/hooks/use-invoke";
import type { Message } from "@/types";
import type { RunProjection, TaskEvent } from "@/features/task-instance/graph/use-task-graph";

export interface RunEventStreamState {
  /** 投影后的消息列表（按 run_seq 顺序，喂给 MessageView）。 */
  projectedMessages: Message[];
  /** 最近一次轮询的 run_seq 游标。 */
  cursor: number;
  /** 是否正在轮询。 */
  polling: boolean;
  /** 运行状态（来自 RunProjection）。 */
  runStatus: string | null;
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
function eventToMessage(event: TaskEvent): Message | null {
  const payload = event.payload ?? {};
  const text = describeEvent(event.event_type, payload);
  if (!text) return null;
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: event.occurred_at,
  };
}

/** 将事件类型 + payload 描述为可读文本。 */
function describeEvent(
  eventType: string,
  payload: Record<string, unknown>,
): string {
  switch (eventType) {
    case "node_started":
    case "NodeStarted": {
      const nodeId = String(payload.node_id ?? "");
      const title = String(payload.node_title ?? nodeId);
      return `▶ 节点开始：${title}`;
    }
    case "node_succeeded":
    case "NodeSucceeded": {
      const nodeId = String(payload.node_id ?? "");
      return `✓ 节点完成：${nodeId}`;
    }
    case "node_failed":
    case "NodeFailed": {
      const nodeId = String(payload.node_id ?? "");
      const error = String(payload.error ?? "");
      return `✗ 节点失败：${nodeId}${error ? `（${error}）` : ""}`;
    }
    case "approval_requested":
    case "ApprovalRequested": {
      const desc = String(payload.description ?? "需要审批");
      return `⚠ 审批请求：${desc}`;
    }
    case "interaction_request":
    case "InteractionRequested": {
      const prompt = String(payload.prompt ?? "需要交互");
      return `? 交互请求：${prompt}`;
    }
    case "run_completed":
    case "RunCompleted":
      return "● 运行完成";
    case "run_failed":
    case "RunFailed":
      return "● 运行失败";
    default:
      return "";
  }
}

export function useRunEventStream(options: UseRunEventStreamOptions): RunEventStreamState {
  const { runId, pollIntervalMs = 1000 } = options;

  const [projectedMessages, setProjectedMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState(0);
  const [polling, setPolling] = useState(false);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          .map(eventToMessage)
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
        setRunStatus(projection.status);
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
