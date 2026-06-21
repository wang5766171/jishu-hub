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
import type { TaskPhase } from "./types";

interface PhaseConversationShellProps {
  sessionId: string | null;
  phase: TaskPhase;
  readOnly: boolean;
  projectPath: string;
  encodedProjectId?: string;
  /** 隐藏指令注入（阶段专属）。 */
  prepareMessage?: (message: string) => PreparedMessage;
  /** session 解析为真实 id 后的回调。 */
  onSessionResolved?: (realSessionId: string) => void;
  /** 会话末尾嵌入的确认卡片（如需求定稿卡 / 流程图生成卡）。 */
  embeddedCard?: React.ReactNode;
  /** 输入框底部额外信息（项目名、模型、skill 等）。 */
  inputContextFooter?: React.ReactNode;
}

export function PhaseConversationShell({
  sessionId,
  phase,
  readOnly,
  projectPath,
  encodedProjectId,
  prepareMessage,
  onSessionResolved,
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
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 流式输出时自动滚到底。
  useEffect(() => {
    if (chat.stream && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chat.stream?.text, chat.stream?.content.length]);

  const isStreaming = chat.stream?.isStreaming ?? false;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3 px-4 py-4">
          <MessageView messages={chat.messages} />

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
              placeholder={`输入消息…（${phase === "requirements" ? "需求讨论" : "流程规划"}）`}
              prepareMessageForAgent={
                prepareMessage
                  ? (msg) => prepareMessage(msg).agent
                  : undefined
              }
              onSessionResolved={async (_pending, real) => {
                onSessionResolved?.(real);
              }}
              contextFooter={inputContextFooter}
            />
          </div>
        </div>
      )}
    </div>
  );
}
