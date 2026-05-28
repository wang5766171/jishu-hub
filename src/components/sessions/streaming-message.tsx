import { useEffect, useCallback, memo, useRef } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { User, Bot } from "lucide-react";
import { useStreamStore } from "@/hooks/use-stream-store";
import { InlineImages, stripImagePrompt } from "./inline-image";
import { ToolGroup, classifyToolName } from "@/components/observability/tool-call-card";
import type { ToolCall } from "@/components/observability/tool-call-card";

interface StreamingMessageProps {
  isComplete: boolean;
  userMessage?: string;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}

export const StreamingMessage = memo(function StreamingMessage({ isComplete, userMessage, scrollContainerRef }: StreamingMessageProps) {
  const { text: displayText, thinking: thinkingText, error: errorText, tools: toolUses } = useStreamStore();
  const { t } = useTranslation();
  const userScrolledRef = useRef(false);

  const isNearBottom = useCallback(() => {
    if (!scrollContainerRef?.current) return true;
    const el = scrollContainerRef.current;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, [scrollContainerRef]);

  const scrollToBottom = useCallback(() => {
    if (userScrolledRef.current) return;
    if (scrollContainerRef?.current) {
      const el = scrollContainerRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [scrollContainerRef]);

  // Detect user manual scroll
  useEffect(() => {
    const el = scrollContainerRef?.current;
    if (!el) return;
    const onScroll = () => {
      userScrolledRef.current = !isNearBottom();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef, isNearBottom]);

  // Scroll to bottom when content updates
  useEffect(() => {
    scrollToBottom();
  }, [displayText, thinkingText, errorText, toolUses.length, scrollToBottom]);

  const hasBubbleContent = displayText.length > 0 || thinkingText.length > 0 || errorText.length > 0;
  const hasContent = hasBubbleContent || toolUses.length > 0;

  // 把流式工具调用映射成 ToolCall（暂无 id/output，因为流式只有 input）
  const streamToolCalls: ToolCall[] = toolUses.map((tool, i) => ({
    id: `stream-${i}-${tool.name}`,
    toolName: tool.name,
    kind: classifyToolName(tool.name),
    status: isComplete ? "success" : "running",
    input: (typeof tool.input === "object" && tool.input !== null) ? (tool.input as Record<string, unknown>) : {},
  }));

  return (
    <div className="mx-auto w-full max-w-[var(--message-content-max-width)] space-y-2 px-4 py-3">
      {/* User message bubble */}
      {userMessage && (
        <div className="flex gap-2 w-full justify-end">
          <div className="max-w-[88%] min-w-0 flex flex-col items-end">
            <div className="flex items-center gap-2 mb-0.5 text-[11px]">
              <span className="font-medium text-muted-foreground">{t("sessions.user")}</span>
            </div>
            <div className="rounded-xl px-3 py-2 bg-[var(--message-user-bg)] text-[var(--message-user-fg)] whitespace-pre-wrap break-all overflow-hidden min-w-0 max-w-full" style={{ fontSize: "var(--font-size-prose)" }}>
              <InlineImages text={userMessage} />
              {stripImagePrompt(userMessage)}
            </div>
          </div>
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--icon-avatar-user-bg)] text-[var(--icon-avatar-user)] mt-3.5">
            <User className="h-3 w-3" />
          </div>
        </div>
      )}

      {/* Assistant streaming response */}
      <div className="flex gap-2 w-full justify-start">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--icon-avatar-bot-bg)] text-[var(--icon-avatar-bot)] mt-3.5">
          <Bot className="h-3 w-3" />
        </div>
        <div className="max-w-[88%] min-w-0 flex flex-col">
          <div className="flex items-center gap-2 mb-0.5 text-[11px]">
            <span className="font-medium text-muted-foreground">{t("sessions.assistant")}</span>
          </div>
          {!hasContent && !isComplete ? (
            <div className="rounded-xl px-3 py-2 bg-[var(--message-assistant-bg)] text-[var(--message-assistant-fg)] overflow-hidden">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <span className="inline-block w-1.5 h-4 bg-primary animate-pulse" />
                <span>{t("sessions.thinkingDots")}</span>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              {hasContent && (
                <div className="rounded-xl bg-[var(--message-assistant-bg)] text-[var(--message-assistant-fg)] px-3 py-2 overflow-hidden min-w-0 max-w-full space-y-2">
                  {thinkingText && (
                    <details className="rounded-md border border-border/40 bg-[var(--message-thinking-bg)] px-2.5 py-1.5 text-xs text-muted-foreground">
                      <summary className="cursor-pointer select-none hover:text-foreground">
                        {t("sessions.showThinking")}
                      </summary>
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                        {thinkingText}
                      </pre>
                    </details>
                  )}
                  {displayText && (
                    <div className="markdown-prose overflow-hidden">
                      <ReactMarkdown 
                        remarkPlugins={[remarkGfm]} 
                        rehypePlugins={isComplete ? [rehypeHighlight] : []}
                      >
                        {displayText}
                      </ReactMarkdown>
                      {!isComplete && <span className="inline-block w-1.5 h-4 bg-primary animate-pulse ml-0.5" />}
                    </div>
                  )}
                  {errorText && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-sm text-destructive">
                      {errorText}
                    </div>
                  )}
                  {!displayText && !isComplete && (
                    <span className="inline-block w-1.5 h-4 bg-primary animate-pulse" />
                  )}
                  {streamToolCalls.length > 0 && (
                    <div className="rounded-lg">
                      <ToolGroup calls={streamToolCalls} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
