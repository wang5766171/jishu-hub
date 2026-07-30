/**
 * PhaseConversationShell —— 需求/规划阶段共享的会话视图骨架。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §6、§3.3。
 *
 * 复用 ChatInput + MessageView + StreamingMessage 通用组件（会话能力真复用），
 * 由 useChatSession 提供消息加载/流式/交互。阶段差异通过 props 注入（prepareMessage、
 * 嵌入卡片、onFinalize 等回调）。
 */
import { useEffect, useRef } from "react";
import { ChatInput } from "@/components/sessions/chat-input";
import { MessageView } from "@/components/sessions/message-view";
import { StreamingMessage } from "@/components/sessions/streaming-message";
import { useChatSession } from "@/features/chat-core/use-chat-session";
import type { PreparedMessage } from "@/features/chat-core/types";
import type { ConversationInteractionRequest, ConversationInteractionSubmission } from "@/types";
import type { TaskPhase } from "./types";

interface PhaseConversationShellProps {
  sessionId: string | null;
  /** 当前阶段（可选；节点会话不传）。用于推导锚点与 placeholder 默认值。 */
  phase?: TaskPhase;
  readOnly: boolean;
  projectPath: string;
  encodedProjectId?: string;
  /** 滚动锚点阶段名（覆盖 phase 推导）。切标签时定位到对应 PhaseDivider（data-phase）。 */
  anchorPhase?: string;
  /** ChatInput placeholder（覆盖 phase 推导的默认值）。 */
  placeholder?: string;
  /** 隐藏指令注入（阶段专属）。 */
  prepareMessage?: (message: string) => PreparedMessage;
  /** session 解析为真实 id 后的回调。 */
  onSessionResolved?: (realSessionId: string) => void;
  /** 一轮 agent turn 结束后的回调（阶段推进同步：刷新任务实例感知 current_phase 变化）。 */
  onTurnComplete?: () => void;
  /** 会话末尾嵌入的确认卡片（如需求定稿卡 / 流程图生成卡）。 */
  embeddedCard?: React.ReactNode;
  /** 输入框底部额外信息（项目名、模型、skill 等）。 */
  inputContextFooter?: React.ReactNode;
}

function toConversationInteractionRequest(
  interaction: ReturnType<typeof useChatSession>["pendingInteractions"][number] | null,
): ConversationInteractionRequest | null {
  if (!interaction) return null;
  return {
    requestId: interaction.requestId,
    prompt: interaction.prompt,
    options: interaction.options,
    allowMultiple: interaction.allowMultiple,
    allowCustomText: interaction.allowCustomText,
    required: interaction.required,
    transport: interaction.transport as ConversationInteractionRequest["transport"],
    origin: interaction.origin as ConversationInteractionRequest["origin"],
    deliveryHint: interaction.deliveryHint ?? undefined,
  };
}

export function PhaseConversationShell({
  sessionId,
  phase,
  readOnly,
  projectPath,
  encodedProjectId,
  anchorPhase,
  placeholder,
  prepareMessage,
  onSessionResolved,
  onTurnComplete,
  embeddedCard,
  inputContextFooter,
}: PhaseConversationShellProps) {
  const chat = useChatSession({
    sessionId: sessionId ?? "",
    projectPath,
    encodedProjectId,
    readOnly,
    prepareMessage,
    onSessionResolved,
    onTurnComplete,
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 流式输出时自动滚到底。
  // ⚠️ 必须用 isStreaming 判断，不能用 chat.stream 对象 truthiness——会话流式过后
  // streamStore 条目长期保留（isStreaming=false 的非 null 对象），对象恒真会让本 effect
  // 把历史会话也钉在底部、并让下方锚点 effect 永不执行（G5+ 批 A 回归根因）。
  useEffect(() => {
    if (chat.stream?.isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chat.stream?.text, chat.stream?.content.length, chat.stream?.isStreaming]);

  // 切标签时的阶段锚点定位：discuss/plan 在同一 conductor 会话内，
  // 切「需求讨论/流程规划」标签需滚到对应 PhaseDivider（而非总会话顶部）。
  // anchorPhase 显式传入时优先，否则按 phase 推导（requirements→discuss, planning→plan）。
  // ⚠️ PhaseDivider 是流式期间注入的瞬态块，不持久化到后端 JSONL。
  // 从后端重新加载消息后 DOM 里不存在 [data-phase] 元素——此时降级为滚底（规划内容在会话末尾）。
  const anchorTarget =
    anchorPhase ?? (phase === "requirements" ? "discuss" : phase === "planning" ? "plan" : null);
  const anchoredKeyRef = useRef<string | null>(null);
  const isStreaming = chat.stream?.isStreaming ?? false;
  useEffect(() => {
    if (!anchorTarget || !scrollRef.current) return;
    if (isStreaming) return; // 流式中交给上面的滚底 effect，不抢占
    const key = `${sessionId ?? "none"}::${anchorTarget}`;
    if (anchoredKeyRef.current === key) return; // 本会话+本锚点已定位过
    const el = scrollRef.current.querySelector(`[data-phase="${anchorTarget}"]`);
    if (el) {
      el.scrollIntoView({ block: "start" });
      anchoredKeyRef.current = key;
    } else if (anchorTarget === "discuss") {
      // discuss 锚点对应会话顶部；divider 尚未产生（如刚发起）则滚顶。
      scrollRef.current.scrollTop = 0;
      anchoredKeyRef.current = key;
    } else if (chat.messages.length > 0) {
      // plan 等锚点：消息已加载但 PhaseDivider 不存在（未持久化）→ 滚到底部（规划内容在末尾）。
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      anchoredKeyRef.current = key;
    }
    // messages.length === 0 且元素未找到 → 消息尚在加载，等下次 dep 变化重试。
  }, [anchorTarget, sessionId, chat.messages.length, isStreaming]);

  const phaseLabel =
    phase === "requirements" ? "需求讨论" : phase === "planning" ? "流程规划" : null;
  const resolvedPlaceholder = placeholder ?? (phaseLabel ? `输入消息…（${phaseLabel}）` : "输入消息…");

  const activeInteraction = chat.pendingInteractions[0] ?? null;
  const interactionRequest = toConversationInteractionRequest(activeInteraction);
  const handleInteractionSubmit = async (submission: ConversationInteractionSubmission) => {
    await chat.respondInteraction({
      selectedOptionIds: submission.selectedOptionIds,
      customText: submission.customText,
    });
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3 px-4 py-4">
          <MessageView messages={chat.messages} flat />

          {sessionId && (
            <StreamingMessage sessionId={sessionId} isComplete={!isStreaming} userMessage={null} />
          )}

          {embeddedCard}
        </div>
      </div>

      {!readOnly && (
        <div className="shrink-0 border-t border-border bg-background">
          <div className="mx-auto max-w-[760px] px-4 py-2">
            <ChatInput
              sessionId={sessionId}
              projectPath={projectPath}
              disabled={false}
              isSessionStreaming={isStreaming}
              placeholder={resolvedPlaceholder}
              prepareMessageForAgent={
                prepareMessage
                  ? (msg) => prepareMessage(msg).agent
                  : undefined
              }
              onSessionResolved={async (_pending, real) => {
                onSessionResolved?.(real);
              }}
              interactionRequest={interactionRequest}
              onInteractionSubmit={handleInteractionSubmit}
              contextFooter={inputContextFooter}
            />
          </div>
        </div>
      )}
    </div>
  );
}
