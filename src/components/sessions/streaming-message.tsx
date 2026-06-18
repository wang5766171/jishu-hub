import { Fragment, useEffect, useCallback, memo, useRef } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useSessionStream } from "@/hooks/use-stream-store";
import { InlineImages, stripImagePrompt } from "./inline-image";
import { ToolGroup, classifyToolName } from "@/components/observability/tool-call-card";
import type { ToolCall } from "@/components/observability/tool-call-card";
import type { ContentBlock } from "@/types";
import { InteractionCard } from "./interaction-card";

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
  const steerSplits = state?.steerSplits ?? [];
  const steerTexts = state?.steerTexts ?? [];
  const interactionSplits = state?.interactionSplits ?? [];
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
  const interactionTextKey = interactionSplits.map((item) => item.text ?? "").join("\n");
  useEffect(() => {
    if (isComplete) return;
    scrollToBottom();
  }, [displayText, thinkingText, errorText, toolUses.length, content.length, interactionTextKey, scrollToBottom, isComplete]);

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
  // Split the content array into assistant segments at the indices where Pi
  // injected a steer (user message) mid-turn. With no splits there is a single
  // segment — identical to the previous single-bubble rendering. steerTexts[i]
  // is the guide Pi injected right before segment i+1, so it renders inline
  // between segment i and segment i+1, matching the final committed order
  // instead of staying pinned at the bottom until the turn completes.
  const sanitizedSplits = Array.from(new Set(steerSplits))
    .filter((idx) => idx > 0 && idx < content.length)
    .sort((a, b) => a - b);
  const userInsertions = [
    ...sanitizedSplits
      .map((index, i) => ({
        kind: "steer" as const,
        index,
        text: steerTexts[i] ?? "",
        order: i,
      }))
      .filter((item) => item.text.length > 0),
    ...interactionSplits
      .map((item, i) => ({
        kind: "interaction" as const,
        index: Math.max(0, Math.min(item.index, content.length)),
        text: item.text ?? "",
        prompt: item.prompt ?? "",
        options: item.options ?? [],
        origin: item.origin,
        order: sanitizedSplits.length + i,
      })),
  ].sort((a, b) => a.index - b.index || a.order - b.order);

  type GroupedInsertion =
    | { kind: "steer"; index: number; text: string }
    | {
        kind: "interaction";
        index: number;
        items: Array<{
          prompt: string;
          options: Array<{ option_id: string; label: string; description?: string | null }>;
          text: string;
        }>;
        origin?: string;
      };

  const groupedInsertions: GroupedInsertion[] = [];
  for (const ins of userInsertions) {
    if (ins.kind === "interaction") {
      const last = groupedInsertions[groupedInsertions.length - 1];
      if (last && last.kind === "interaction" && last.index === ins.index) {
        last.items.push({
          prompt: ins.prompt,
          options: ins.options,
          text: ins.text,
        });
      } else {
        groupedInsertions.push({
          kind: "interaction",
          index: ins.index,
          items: [{
            prompt: ins.prompt,
            options: ins.options,
            text: ins.text,
          }],
          origin: ins.origin,
        });
      }
    } else {
      groupedInsertions.push({
        kind: "steer",
        index: ins.index,
        text: ins.text,
      });
    }
  }

  type StreamPart =
    | { kind: "assistant"; content: ContentBlock[] }
    | { kind: "user"; text: string; guided: boolean }
    | {
        kind: "interaction";
        items: Array<{
          prompt: string;
          options: Array<{ option_id: string; label: string; description?: string | null }>;
          answer: string;
        }>;
        origin?: string;
      };

  const parts: StreamPart[] = [];
  let previousIndex = 0;
  for (const insertion of groupedInsertions) {
    parts.push({
      kind: "assistant",
      content: content.slice(previousIndex, insertion.index),
    });
    if (insertion.kind === "interaction") {
      parts.push({
        kind: "interaction",
        items: insertion.items.map(item => ({
          prompt: item.prompt,
          options: item.options,
          answer: item.text,
        })),
        origin: insertion.origin,
      });
    } else {
      parts.push({
        kind: "user",
        text: insertion.text,
        guided: true,
      });
    }
    previousIndex = insertion.index;
  }
  parts.push({ kind: "assistant", content: content.slice(previousIndex) });
  const lastAssistantPartIndex = parts.reduce(
    (last, part, index) => part.kind === "assistant" ? index : last,
    -1,
  );

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

      {/* Assistant streaming response — one bubble per segment, with an inline
          guide bubble (steerTexts[i]) rendered between segment i and i+1 when a
          steer was injected mid-turn at a tool-call gap. Error/steps/processing
          marquee attach to the last (still-streaming) segment only. With no
          steer splits there is a single segment, identical to the previous
          single-bubble rendering. */}
      {parts.map((part, i) => {
        if (part.kind === "user") {
          return (
            <UserBubble
              key={`user-insertion-${i}`}
              text={part.text}
              guided={part.guided}
            />
          );
        }

        if (part.kind === "interaction") {
          return (
            <InteractionCard
              key={`interaction-${i}`}
              items={part.items}
              origin={part.origin}
              defaultOpen={false}
            />
          );
        }

        const seg = part.content;
        const isLast = i === lastAssistantPartIndex;
        const segRenderItems = buildStreamRenderItems(seg, streamToolCalls);
        const segHasItems = segRenderItems.length > 0;
        const showBubble = segHasItems || (isLast && (errorText.length > 0 || steps.length > 0));
        const showThinking = isLast && !showBubble && !isComplete;
        if (!showBubble && !showThinking) return null;
        return (
          <Fragment key={`asst-seg-${i}`}>
            <div className="w-full">
              <div className="max-w-full min-w-0 flex flex-col">
                <div className="flex items-center gap-2 mb-0.5 text-[11px]">
                  <span className="font-medium text-muted-foreground">{t("sessions.assistant")}</span>
                </div>
                {showThinking ? (
                  <div className="rounded-xl px-3 py-2 bg-[var(--message-assistant-bg)] text-[var(--message-assistant-fg)] overflow-hidden">
                    <div className="flex min-w-0 items-center gap-2 overflow-hidden text-sm font-medium">
                      <span className="processing-marquee">{t("sessions.thinkingDots")}</span>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {showBubble && (
                      <div className="rounded-xl bg-[var(--message-assistant-bg)] text-[var(--message-assistant-fg)] px-3 py-2 overflow-hidden min-w-0 max-w-full space-y-2">
                        {segRenderItems.map((item, idx) => {
                          if (item.kind === "tools") {
                            return (
                              <div key={`tools-${i}-${idx}`} className="rounded-[8px]">
                                <ToolGroup calls={item.calls} />
                              </div>
                            );
                          }
                          if (item.block.type === "thinking") {
                            return (
                              <details key={`thinking-${i}-${idx}`} className="rounded-[6px] border border-border/40 bg-[var(--message-thinking-bg)] px-2.5 py-1.5 text-xs text-muted-foreground">
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
                            return (
                              <div key={`text-${i}-${idx}`} className="markdown-prose overflow-hidden">
                                <ReactMarkdown
                                  remarkPlugins={REMARK_PLUGINS}
                                  rehypePlugins={isComplete ? REHYPE_PLUGINS_COMPLETE : undefined}
                                >
                                  {item.block.text}
                                </ReactMarkdown>
                              </div>
                            );
                          }
                          return null;
                        })}
                        {isLast && errorText && (
                          <div className="rounded-[6px] border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-sm text-destructive">
                            {errorText}
                          </div>
                        )}
                        {isLast && steps.length > 0 && (
                          <details open className="rounded-[6px] border border-border/40 bg-accent/30 px-2.5 py-1.5">
                            <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
                              {t("sessions.toolCalls", { count: steps.length })}
                            </summary>
                            <div className="mt-1.5 space-y-1">
                              {steps.map((step, j) => (
                                <div key={step.stepId ?? j} className="flex items-center gap-2 text-[11px]">
                                  <StepStatusIcon kind={step.kind} />
                                  <span className="text-muted-foreground font-mono">{step.kind}</span>
                                  <span className="truncate">{step.title}</span>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                        {isLast && !isComplete && (
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
          </Fragment>
        );
      })}
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

/**
 * Inline guide (steer) bubble rendered between assistant segments during
 * streaming. Mirrors the layout of the live bottom placeholder in chat-page
 * (right-aligned user bubble + amber "已引导" chip) so the transition from
 * bottom placeholder → inline, and later → committed message, is seamless.
 */
function UserBubble({ text, guided }: { text: string; guided?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="w-full flex justify-end">
      <div className="max-w-[88%] min-w-0 flex flex-col items-end">
        <div className="flex items-center gap-2 mb-0.5 text-[11px]">
          <span className="font-medium text-muted-foreground">{t("sessions.user")}</span>
          {guided ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-500">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              {t("sessions.steered")}
            </span>
          ) : null}
        </div>
        <div
          className="rounded-xl px-3 py-2 bg-[var(--message-user-bg)] text-[var(--message-user-fg)] whitespace-pre-wrap break-all overflow-hidden min-w-0 max-w-full"
          style={{ fontSize: "var(--font-size-prose)" }}
        >
          {text}
        </div>
      </div>
    </div>
  );
}
