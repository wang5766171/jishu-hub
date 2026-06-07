import { useEffect, useCallback, memo, useRef } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useSessionStream } from "@/hooks/use-stream-store";
import { InlineImages, stripImagePrompt } from "./inline-image";
import { ToolGroup, classifyToolName } from "@/components/observability/tool-call-card";
import type { ToolCall } from "@/components/observability/tool-call-card";
import type { ContentBlock } from "@/types";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS_COMPLETE = [rehypeHighlight];

interface StreamingMessageProps {
  /** Session id (pending or real) whose streaming state to render. */
  sessionId: string | null;
  isComplete?: boolean;
  /**
   * Optional override for the leading user message bubble.
   * When omitted, falls back to the pending user message tracked in the store.
   * Pass `null` to suppress the user bubble entirely (e.g., when the user
   * message is already rendered by `MessageView`).
   */
  userMessage?: string | null;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}

export const StreamingMessage = memo(function StreamingMessage({ sessionId, isComplete = false, userMessage, scrollContainerRef }: StreamingMessageProps) {
  const state = useSessionStream(sessionId);
  const { t } = useTranslation();
  const displayText = state?.text ?? "";
  const thinkingText = state?.thinking ?? "";
  const errorText = state?.error ?? "";
  const toolUses = state?.tools ?? [];
  const content = state?.content ?? [];
  const steps = state?.steps ?? [];
  const resolvedUserMessage = userMessage === undefined ? state?.pendingUserMessage ?? undefined : userMessage ?? undefined;
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

  // Scroll to bottom when content updates (only while actively streaming)
  useEffect(() => {
    if (isComplete) return;
    scrollToBottom();
  }, [displayText, thinkingText, errorText, toolUses.length, content.length, scrollToBottom, isComplete]);

  const hasBubbleContent = content.length > 0 || displayText.length > 0 || thinkingText.length > 0 || errorText.length > 0;
  const hasContent = hasBubbleContent || toolUses.length > 0;

  // Map streaming tool calls to the same card model used by persisted messages.
  const streamToolCalls: ToolCall[] = toolUses.map((tool, i) => ({
    id: tool.id || `stream-${i}-${tool.name}`,
    toolName: tool.name,
    kind: classifyToolName(tool.name),
    status: tool.isError ? "error" : isComplete || tool.output !== undefined ? "success" : "running",
    input: (typeof tool.input === "object" && tool.input !== null) ? (tool.input as Record<string, unknown>) : {},
    output: tool.output === undefined ? undefined : (
      typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output, null, 2)
    ),
  }));
  const renderItems = buildStreamRenderItems(content, streamToolCalls);

  return (
    <div className="mx-auto w-full max-w-[var(--message-content-max-width)] space-y-2 px-4 py-3">
      {/* User message bubble */}
      {resolvedUserMessage && (
        <div className="w-full flex justify-end">
          <div className="max-w-[88%] min-w-0 flex flex-col items-end">
            <div className="flex items-center gap-2 mb-0.5 text-[11px]">
              <span className="font-medium text-muted-foreground">{t("sessions.user")}</span>
            </div>
            <div className="rounded-xl px-3 py-2 bg-[var(--message-user-bg)] text-[var(--message-user-fg)] whitespace-pre-wrap break-all overflow-hidden min-w-0 max-w-full" style={{ fontSize: "var(--font-size-prose)" }}>
              <InlineImages text={resolvedUserMessage} />
              {stripImagePrompt(resolvedUserMessage)}
            </div>
          </div>
        </div>
      )}

      {/* Assistant streaming response */}
      <div className="w-full">
        <div className="max-w-full min-w-0 flex flex-col">
          <div className="flex items-center gap-2 mb-0.5 text-[11px]">
            <span className="font-medium text-muted-foreground">{t("sessions.assistant")}</span>
          </div>
          {!hasContent && !isComplete ? (
            <div className="rounded-xl px-3 py-2 bg-[var(--message-assistant-bg)] text-[var(--message-assistant-fg)] overflow-hidden">
              <div className="flex min-w-0 items-center gap-2 overflow-hidden text-sm font-medium">
                <span className="processing-marquee">{t("sessions.thinkingDots")}</span>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              {hasContent && (
                <div className="rounded-xl bg-[var(--message-assistant-bg)] text-[var(--message-assistant-fg)] px-3 py-2 overflow-hidden min-w-0 max-w-full space-y-2">
                  {renderItems.map((item, idx) => {
                    if (item.kind === "tools") {
                      return (
                        <div key={`tools-${idx}`} className="rounded-[8px]">
                          <ToolGroup calls={item.calls} />
                        </div>
                      );
                    }
                    if (item.block.type === "thinking") {
                      return (
                        <details key={`thinking-${idx}`} className="rounded-[6px] border border-border/40 bg-[var(--message-thinking-bg)] px-2.5 py-1.5 text-xs text-muted-foreground">
                          <summary className="cursor-pointer select-none hover:text-foreground">
                            {t("sessions.showThinking")}
                          </summary>
                          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                            {item.block.thinking}
                          </pre>
                        </details>
                      );
                    }
                    if (item.block.type === "text") {
                      return isComplete ? (
                        <div key={`text-${idx}`} className="markdown-prose overflow-hidden">
                          <ReactMarkdown
                            remarkPlugins={REMARK_PLUGINS}
                            rehypePlugins={REHYPE_PLUGINS_COMPLETE}
                          >
                            {item.block.text}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <div key={`text-${idx}`} className="markdown-prose overflow-hidden whitespace-pre-wrap break-words">
                          {item.block.text}
                        </div>
                      );
                    }
                    return null;
                  })}
                  {errorText && (
                    <div className="rounded-[6px] border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-sm text-destructive">
                      {errorText}
                    </div>
                  )}
                  {steps.length > 0 && (
                    <details open className="rounded-[6px] border border-border/40 bg-accent/30 px-2.5 py-1.5">
                      <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
                        {t("sessions.toolCalls", { count: steps.length })}
                      </summary>
                      <div className="mt-1.5 space-y-1">
                        {steps.map((step, i) => (
                          <div key={step.stepId ?? i} className="flex items-center gap-2 text-[11px]">
                            <StepStatusIcon kind={step.kind} />
                            <span className="text-muted-foreground font-mono">{step.kind}</span>
                            <span className="truncate">{step.title}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {!isComplete && (
                    <div className="flex min-w-0 items-center gap-2 overflow-hidden text-sm font-medium">
                      <span className="processing-marquee">
                        {toolUses.length > 0 ? t("sessions.toolCalling") : t("sessions.processing")}
                      </span>
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

type StreamRenderItem =
  | { kind: "block"; block: ContentBlock }
  | { kind: "tools"; calls: ToolCall[] };

function buildStreamRenderItems(content: ContentBlock[], calls: ToolCall[]): StreamRenderItem[] {
  const callMap = new Map(calls.map((call) => [call.id, call]));
  const items: StreamRenderItem[] = [];
  let pendingTools: ToolCall[] = [];

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    items.push({ kind: "tools", calls: pendingTools });
    pendingTools = [];
  };

  for (const block of content) {
    if (block.type === "tool_use") {
      const call = callMap.get(block.id);
      if (call) pendingTools.push(call);
      continue;
    }
    if (block.type === "tool_result") continue;
    flushTools();
    items.push({ kind: "block", block });
  }

  flushTools();
  return items;
}

function StepStatusIcon({ kind }: { kind: string }) {
  const color = kind === "done" ? "text-[var(--icon-success)]"
    : kind === "failed" ? "text-[var(--color-destructive)]"
    : "text-[var(--icon-action)]";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
}
