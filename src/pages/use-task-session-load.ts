/**
 * use-task-session-load —— 任务/节点会话消息加载（v0.9.7 需求2 补充：
 * chat-page 简化簇B，自 §12 预案迁移，零逻辑变更纯移动）。
 *
 * 职责（原文件 1097-1228 effect）：任务模式下 selectedSession 变更
 * （进入任务/切节点/切回主会话）不走 handleSelectSession，由本 effect 兜底
 * 加载消息：缓存先行防闪空 → 节点会话按 attempt 绑定 agent_id 重读最新
 * 基线 → 空载有限重试（1.5s × 3）+ 首条流式文本触发重载 → 入口双 rAF
 * 定位（首访到底/重访恢复）→ cleanup 落盘 scrollMemory。
 *
 * 隐式执行序（fix22 警示）：滚动指令消费（use-chat-scroll）→ 本加载 →
 * 节点会话轮询回填（use-node-session 层）——迁移保留原序。
 */
import { useEffect, useRef, type RefObject } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { streamStore } from "@/hooks/use-stream-store";
import { filterInvisibleUserMessages } from "./chat-page-utils";
import {
  getCachedSessionMessages,
  setCachedSessionMessages,
} from "@/features/session-kernel/kernel/session-cache";
import type { Message } from "@/types";

export function useTaskSessionLoad({
  taskModeActive,
  selectedSession,
  projectId,
  taskSelectedNodeId,
  taskNodeSessionAgentId,
  activeId,
  streamTextStarted,
  messageAreaRef,
  scrollMemory,
  sessionMessagesRef,
  setSessionMessages,
}: {
  taskModeActive: boolean;
  selectedSession: string | null;
  projectId: string | null;
  taskSelectedNodeId: string | null;
  taskNodeSessionAgentId: string | null;
  activeId: string | null;
  /** 首条流式文本已到达（布尔依赖，避免逐 delta 重载刷 IPC）。 */
  streamTextStarted: boolean;
  messageAreaRef: RefObject<HTMLDivElement | null>;
  scrollMemory: RefObject<Map<string, number | "bottom">>;
  sessionMessagesRef: RefObject<Message[]>;
  setSessionMessages: (messages: Message[]) => void;
}): void {
  // 入口标记：entry key（sid#nodeId）变化 = 新入口需定位；同一入口的流式
  // 重载不重复定位；消息未非空时定位保持待定。
  const taskEntryKeyRef = useRef<string | null>(null);
  const taskScrollPendingRef = useRef<string | null>(null);

  useEffect(() => {
    if (!taskModeActive || !selectedSession || selectedSession === "new" || !projectId) {
      // 离开任务模式后复位入口标记：下次进入同一任务会话仍算新入口（需定位）。
      if (!taskModeActive) {
        taskEntryKeyRef.current = null;
        taskScrollPendingRef.current = null;
      }
      return;
    }
    if (selectedSession === "pending-node") return;
    // 节点会话流式期间无历史修复：照常加载；仅当该会话走「普通发送路径」
    //（流式态含 pendingUserMessage，用户消息由流式气泡渲染）时截断本轮
    // 回合消息防重复——节点会话派发 prompt 走 spawn 参数、气泡无用户消息。
    const truncateStreamingTurn = (messages: Message[]): Message[] => {
      const pending = streamStore.getState(selectedSession)?.pendingUserMessage ?? null;
      if (!streamStore.isStreaming(selectedSession) || pending == null) return messages;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== "user") continue;
        const text = m.content.find((c) => c.type === "text")?.text ?? null;
        if (text === pending) return messages.slice(0, i);
      }
      return messages;
    };

    // 入口定位：双 rAF 等布局稳定（markdown 撑高）再定位；"bottom" 语义滚
    // 到最新底（离开后内容继续增长，绝对像素恢复会落在中间旧消息）。
    const entryKey = `${selectedSession}#${taskSelectedNodeId ?? "main"}`;
    const isNewEntry = taskEntryKeyRef.current !== entryKey;
    if (isNewEntry) {
      taskEntryKeyRef.current = entryKey;
      taskScrollPendingRef.current = entryKey;
    }
    const positionIfPending = () => {
      if (taskScrollPendingRef.current !== entryKey) return;
      taskScrollPendingRef.current = null;
      const saved = scrollMemory.current.get(selectedSession);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = messageAreaRef.current;
          if (!el) return;
          if (saved === "bottom" || saved === undefined) {
            el.scrollTop = el.scrollHeight;
          } else {
            el.scrollTop = Math.max(0, Math.min(saved, el.scrollHeight - el.clientHeight));
          }
        });
      });
    };

    const cached = getCachedSessionMessages(selectedSession);
    // 节点会话可能在离开期间继续跑（后台节点的事件不进本视图），缓存往往
    // 是上次进入时的半截快照——先渲染缓存避免闪空，再重读取最新基线；此后
    // 增量由 agent-event 流式接续（与常规会话同一套机制）。
    const isNodeSession = !!taskSelectedNodeId;
    if (cached) {
      setSessionMessages(cached);
      if (cached.length > 0) positionIfPending();
      if (!isNodeSession) return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // 节点会话用节点 attempt 绑定的 agent_id 加载消息（节点子代理可能是
    // claude-code/codex 等非 jishu-self，消息存在各自 session 存储）。
    const nodeAgentId = isNodeSession ? (taskNodeSessionAgentId ?? activeId ?? "") : (activeId ?? "");
    const load = (attempt: number) => {
      invokeCommand<Message[]>("get_session_messages", {
        agentId: nodeAgentId,
        sessionId: selectedSession,
        encodedName: projectId,
      })
        .then((messages) => {
          if (cancelled) return;
          const visibleMessages = truncateStreamingTurn(filterInvisibleUserMessages(messages));
          setCachedSessionMessages(selectedSession, visibleMessages);
          setSessionMessages(visibleMessages);
          if (visibleMessages.length > 0) {
            positionIfPending();
            return;
          }
          // 节点会话进入早于派发 prompt 落盘：JSONL 读空时有限重试
          //（1.5s × 3），之后由 streamTextStarted 触发重载兜底。
          if (isNodeSession && attempt < 3) {
            retryTimer = setTimeout(() => load(attempt + 1), 1500);
          }
        })
        .catch(() => {
          if (!cancelled && !cached) setSessionMessages([]);
        });
    };
    load(0);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      // 离开该任务会话时记录滚动位置——任务会话不经 handleSelectSession，
      // 此前从未保存 scrollMemory。占位/空消息不落盘（避免把 0 写进记忆）。
      // 读 sessionMessagesRef（每渲染同步）：cleanup 闭包里的 state 是入口
      // 时的快照，异步加载完成后并不更新。
      if (
        selectedSession !== "pending-node" &&
        selectedSession !== "new" &&
        messageAreaRef.current &&
        sessionMessagesRef.current.length > 0
      ) {
        scrollMemory.current.set(selectedSession, messageAreaRef.current.scrollTop);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskModeActive, selectedSession, projectId, taskSelectedNodeId, taskNodeSessionAgentId, activeId, streamTextStarted]);
}
