/**
 * useChatSession —— 通用会话核心 hook。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §2.3、§11（五条设计原则 + 红线）。
 *
 * 五条设计原则（强制遵守）：
 *   1. 通用 hook，零任务语义耦合 —— hook 只知道 session，不知道 task/phase/requirement/node。
 *   2. 阶段差异只能通过声明式入参表达 —— prepareMessage、onInteractionSubmit 等。
 *   3. 切换 session 不重建实例，只重载消息 —— sessionId 变化时内部 useEffect 重新加载。
 *   4. 新会话能力只在此一处增强 —— 后续会话能力增强只需改本 hook。
 *   5. 单向数据流，状态收敛在 hook —— 不向消费方泄漏内部状态。
 *
 * 红线：本 hook 内部不得出现任何 "task"/"phase"/"requirement"/"node" 字样。
 *       阶段差异必须通过 UseChatSessionOptions 的字段表达，禁止内部 if(phase===...) 分支。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import {
  streamStore,
  useSessionStream,
  type SessionStreamState,
} from "@/hooks/use-stream-store";
import type {
  AgentEventPayload,
  AgentStreamChunk,
  ChatSession,
  ConversationInteractionRequest,
  ConversationInteractionSubmission,
  InteractionDeliveryHint,
  InteractionOrigin,
  InteractionTransport,
  Message,
} from "@/types";
import {
  formatInteractionReply,
  formatInteractionResponseValue,
} from "@/lib/conversation-interaction";
import { listen } from "@tauri-apps/api/event";
import type {
  ChatSessionState,
  ChatStreamState,
  InteractionSubmission,
  PendingChatApproval,
  PendingChatInteraction,
  PreparedMessage,
  UseChatSessionOptions,
} from "./types";

/** 默认消息预处理：visible === agent，不注入任何隐藏指令。 */
function identityPrepare(message: string): PreparedMessage {
  return { visible: message, agent: message };
}

/** 从 SessionStreamState 聚合为对外暴露的 ChatStreamState。 */
function toStreamState(state: SessionStreamState | null): ChatStreamState | null {
  if (!state) return null;
  return {
    content: state.content,
    text: state.text,
    thinking: state.thinking,
    tools: state.tools,
    steps: state.steps,
    interactionSplits: state.interactionSplits,
    isStreaming: state.isStreaming,
    error: state.error,
  };
}

/** 从 agent-event 的 interaction_request chunk 解析为 PendingChatInteraction。
 *
 *  注意：此函数只做"事件 → 通用交互项"的归一化，不涉及任何任务语义。
 */
function interactionFromEvent(event: unknown): PendingChatInteraction | null {
  if (!event || typeof event !== "object") return null;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const kind = (data as { kind?: string }).kind;
  if (kind !== "interaction_request") return null;
  const d = data as {
    request_id?: string;
    prompt?: string;
    options?: Array<{ option_id?: string; label?: string; description?: string | null }>;
    origin?: string;
    transport?: string;
    delivery_hint?: string | null;
    allow_custom_text?: boolean;
    allow_multiple?: boolean;
    required?: boolean;
  };
  return {
    requestId: d.request_id ?? "",
    prompt: d.prompt ?? "",
    options: (d.options ?? []).map((o) => ({
      optionId: o.option_id ?? "",
      label: o.label ?? "",
      description: o.description ?? null,
    })),
    origin: d.origin ?? "",
    transport: d.transport ?? "",
    deliveryHint: d.delivery_hint === "follow_up" || d.delivery_hint === "mid_turn"
      ? d.delivery_hint
      : null,
    allowCustomText: d.allow_custom_text ?? false,
    allowMultiple: d.allow_multiple ?? false,
    required: d.required ?? true,
  };
}

function interactionTransport(value: string): InteractionTransport | undefined {
  return ["unspecified", "pi_rpc", "acp_preferred", "codex_app_server", "cli", "embedded"]
    .includes(value)
    ? value as InteractionTransport
    : undefined;
}

function interactionOrigin(value: string): InteractionOrigin | undefined {
  return ["text", "extension_ui", "acp_elicitation", "codex_tool_request_user_input", "codex_mcp_approval", "codex_approval"]
    .includes(value)
    ? value as InteractionOrigin
    : undefined;
}

function interactionDeliveryHint(
  value: "follow_up" | "mid_turn" | null,
): InteractionDeliveryHint | undefined {
  return value ?? undefined;
}

function toConversationInteractionRequest(
  interaction: PendingChatInteraction,
): ConversationInteractionRequest {
  return {
    requestId: interaction.requestId,
    prompt: interaction.prompt,
    options: interaction.options,
    allowMultiple: interaction.allowMultiple,
    allowCustomText: interaction.allowCustomText,
    required: interaction.required,
    transport: interactionTransport(interaction.transport),
    origin: interactionOrigin(interaction.origin),
    deliveryHint: interactionDeliveryHint(interaction.deliveryHint),
    correlation: null,
  };
}

function toConversationInteractionSubmission(
  requestId: string,
  submission: InteractionSubmission,
): ConversationInteractionSubmission {
  return {
    requestId,
    selectedOptionIds: submission.selectedOptionIds,
    customText: submission.customText ?? "",
  };
}

/** 从 agent-event 的 approval_request chunk 解析为 PendingChatApproval。 */
function approvalFromEvent(event: unknown): PendingChatApproval | null {
  if (!event || typeof event !== "object") return null;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const kind = (data as { kind?: string }).kind;
  if (kind !== "approval_request") return null;
  const d = data as {
    request_id?: string;
    tool_name?: string;
    approval_kind?: string;
    input?: unknown;
    payload?: unknown;
    summary?: string;
  };
  return {
    requestId: d.request_id ?? "",
    toolName: d.tool_name ?? d.approval_kind ?? "",
    input: d.input ?? d.payload,
    summary: d.summary ?? "",
  };
}

function normalizeAgentEventPayload(payload: AgentEventPayload): AgentStreamChunk[] {
  return Array.isArray(payload) ? payload : [payload];
}

function chunkMatchesSession(
  chunk: AgentStreamChunk,
  sessionId: string,
  resolvedSessionId: string,
): boolean {
  if (!sessionId) return false;
  return chunk.session_id === sessionId || chunk.session_id === resolvedSessionId;
}

/**
 * 通用会话核心 hook。
 *
 * 消费方：chat-page（常规会话）、TaskPhaseContainer 的需求/规划阶段、执行阶段节点子代理会话。
 *
 * 用法：
 * ```ts
 * const chat = useChatSession({
 *   sessionId: instance.requirement_session_id,
 *   encodedProjectId,
 *   readOnly: false,
 *   prepareMessage: (msg) => injectSkillInstructions(msg, skillId),
 *   onSessionResolved: (realId) => markSession(realId),
 *   onInteractionSubmit: (sub, inter) => handleFinalize(inter),
 * });
 * ```
 */
export function useChatSession(options: UseChatSessionOptions): ChatSessionState {
  const {
    sessionId,
    encodedProjectId,
    readOnly,
    prepareMessage,
    onSessionResolved,
    onInteractionSubmit,
  } = options;

  // ── 消息历史 ──
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  // 消息缓存（按 session id），避免来回切换时重复拉取。
  const messagesCacheRef = useRef<Map<string, Message[]>>(new Map());

  const loadMessages = useCallback(
    async (sid: string, force = false) => {
      if (!sid) {
        setMessages([]);
        return;
      }
      if (!force) {
        const cached = messagesCacheRef.current.get(sid);
        if (cached) {
          setMessages(cached);
          return;
        }
      }
      setLoadingMessages(true);
      try {
        const result = await invokeCommand<Message[]>("get_session_messages", {
          sessionId: sid,
          encodedName: encodedProjectId,
        });
        const list = result ?? [];
        messagesCacheRef.current.set(sid, list);
        setMessages(list);
      } catch (err) {
        console.error("Failed to load session messages:", err);
        setMessages([]);
      } finally {
        setLoadingMessages(false);
      }
    },
    [encodedProjectId],
  );

  // sessionId 变化 → 重新加载消息（命中缓存优先）。
  useEffect(() => {
    loadMessages(sessionId);
  }, [sessionId, loadMessages]);

  // ── 流式状态（复用 streamStore 单例 + useSessionStream 订阅）──
  const rawStream: SessionStreamState | null = useSessionStream(sessionId);
  const stream = toStreamState(rawStream);

  // ── 交互问答 / 审批（从 agent-event 监听）──
  const [pendingInteractions, setPendingInteractions] = useState<PendingChatInteraction[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingChatApproval[]>([]);
  // resolvedSessionId: 若 pending → real 解析发生，记录真实 id。
  const resolvedSessionIdRef = useRef<string>(sessionId);

  // 监听 agent-event：只处理与当前 session 相关的 interaction_request / approval_request /
  // session_resolved。其它 chunk 由 streamStore 自己消费（通过 streamStore.push）。
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        unlisten = await listen<AgentEventPayload>("agent-event", (event) => {
          if (!active) return;
          const payload = event.payload;
          if (!payload) return;

          for (const chunk of normalizeAgentEventPayload(payload)) {
            if (!chunkMatchesSession(chunk, sessionId, resolvedSessionIdRef.current)) {
              continue;
            }

            streamStore.pushTracked(chunk.session_id, chunk);

            // interaction_request → pendingInteractions
            const interaction = interactionFromEvent(chunk);
            if (interaction && interaction.requestId) {
              setPendingInteractions((prev) =>
                prev.some((i) => i.requestId === interaction.requestId)
                  ? prev
                  : [...prev, interaction],
              );
            }

            // approval_request → pendingApprovals
            const approval = approvalFromEvent(chunk);
            if (approval && approval.requestId) {
              setPendingApprovals((prev) =>
                prev.some((a) => a.requestId === approval.requestId)
                  ? prev
                  : [...prev, approval],
              );
            }

            // session_resolved → onSessionResolved 回调
            const data = chunk.data;
            if (data?.kind === "session_resolved" && data.session_id) {
              const realId = data.session_id;
              if (realId !== resolvedSessionIdRef.current) {
                resolvedSessionIdRef.current = realId;
                streamStore.alias(sessionId, realId);
                onSessionResolved?.(realId);
              }
            }
          }
        });
      } catch (err) {
        console.error("useChatSession: failed to listen agent-event:", err);
      }
    })();

    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, [sessionId, onSessionResolved]);

  // 切换 session 时清理 pending（避免上一个 session 的交互串到新 session）。
  useEffect(() => {
    setPendingInteractions([]);
    setPendingApprovals([]);
    resolvedSessionIdRef.current = sessionId;
  }, [sessionId]);

  // ── 发送消息 ──
  const prepare = prepareMessage ?? identityPrepare;

  const send = useCallback(
    async (message: string) => {
      if (readOnly || !sessionId) return;
      const trimmed = message.trim();
      if (!trimmed) return;

      const { visible, agent } = prepare(trimmed);

      // 复刻 ChatInput 的发送链路核心：start → send_message → alias。
      streamStore.start(sessionId, visible);
      try {
        const chatSession = await invokeCommand<ChatSession>("send_message", {
          projectPath: options.projectPath,
          sessionId,
          message: agent,
        });
        if (chatSession?.session_id && chatSession.session_id !== sessionId) {
          streamStore.alias(sessionId, chatSession.session_id);
        }
      } catch (err) {
        console.error("useChatSession: send_message failed:", err);
        streamStore.drop(sessionId);
        throw err;
      }
    },
    [readOnly, sessionId, prepare, options.projectPath],
  );

  // ── 停止流 ──
  const stop = useCallback(async () => {
    if (!sessionId) return;
    const state = streamStore.getState(sessionId);
    if (!state) return;
    try {
      await invokeCommand("abort_chat", { sessionId: state.abortKey });
    } catch (err) {
      console.error("useChatSession: abort_chat failed:", err);
    } finally {
      streamStore.drop(sessionId);
    }
  }, [sessionId]);

  // ── 提交交互问答 ──
  const respondInteraction = useCallback(
    async (submission: InteractionSubmission) => {
      if (readOnly) return;
      const target = pendingInteractions[0];
      if (!target) return;

      const request = toConversationInteractionRequest(target);
      const normalizedSubmission = toConversationInteractionSubmission(
        target.requestId,
        submission,
      );
      const value = formatInteractionResponseValue(request, normalizedSubmission);
      const checkpoint = streamStore.recordInteractionResponseWithCheckpoint(
        sessionId,
        target.requestId,
        value,
        submission.selectedOptionIds,
      );
      setPendingInteractions((prev) =>
        prev.filter((item) => item.requestId !== target.requestId),
      );

      try {
        const result = await invokeCommand<{ delivery: "mid_turn" | "follow_up" }>(
          "respond_chat_interaction",
          {
            sessionId,
            requestId: target.requestId,
            value,
            interaction: {
              request_id: target.requestId,
              prompt: target.prompt,
              options: target.options.map((option) => ({
                option_id: option.optionId,
                label: option.label,
                description: option.description ?? null,
              })),
              answer: value,
              selected_options: submission.selectedOptionIds,
              origin: target.origin || null,
            },
            origin: target.origin,
          },
        );

        if (result?.delivery === "follow_up") {
          streamStore.removeInteractionSplit(sessionId, target.requestId);
          const reply = formatInteractionReply(request, normalizedSubmission).trim();
          if (reply) await send(reply);
        }
        onInteractionSubmit?.(submission, target);
      } catch (err) {
        streamStore.rollbackInteractionResponse(checkpoint);
        setPendingInteractions((prev) =>
          prev.some((item) => item.requestId === target.requestId)
            ? prev
            : [target, ...prev],
        );
        console.error("useChatSession: respond_chat_interaction failed:", err);
        throw err;
      }
    },
    [readOnly, sessionId, pendingInteractions, onInteractionSubmit, send],
  );

  // ── 审批决策 ──
  const resolveApproval = useCallback(
    async (requestId: string, approved: boolean) => {
      if (readOnly || !sessionId) return;
      try {
        await invokeCommand("resolve_chat_permission", { sessionId, requestId, approved });
        setPendingApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
      } catch (err) {
        console.error("useChatSession: resolve_chat_permission failed:", err);
      }
    },
    [readOnly, sessionId],
  );

  // ── 刷新消息 ──
  const refreshMessages = useCallback(async () => {
    await loadMessages(sessionId, true);
  }, [sessionId, loadMessages]);

  const canSend = !readOnly && !!sessionId;

  return {
    sessionId,
    readOnly,
    messages,
    stream,
    pendingInteractions,
    pendingApprovals,
    loadingMessages,
    canSend,
    send,
    stop,
    respondInteraction,
    resolveApproval,
    refreshMessages,
  };
}
