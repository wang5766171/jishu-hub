import { useState, useEffect, useRef, useCallback, memo } from "react";
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
  const chunks = useStreamStore();
  const { t } = useTranslation();
  const [displayText, setDisplayText] = useState("");
  const [toolUses, setToolUses] = useState<Array<{ name: string; input: unknown }>>([]);
  const textRef = useRef("");
  const toolsRef = useRef<Array<{ name: string; input: unknown }>>([]);
  const rafRef = useRef<number>(0);
  const processedCount = useRef(0);
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

  // Batch text updates via ref + rAF for smooth streaming
  useEffect(() => {
    const newChunks = chunks.slice(processedCount.current);
    if (newChunks.length === 0) return;

    for (const chunk of newChunks) {
      if (chunk.event_type === "delta") {
        const delta = (chunk.data as Record<string, unknown>)?.event as Record<string, unknown> | undefined;
        const deltaObj = delta?.delta as Record<string, unknown> | undefined;
        if (deltaObj?.type === "text_delta" && typeof deltaObj.text === "string") {
          textRef.current += deltaObj.text;
        }
      } else if (chunk.event_type === "message") {
        const content = (chunk.data as Record<string, unknown>)?.content as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const block of content) {
            if (block.type === "tool_use") {
              toolsRef.current.push({ name: block.name as string, input: block.input });
            }
          }
        }
      }
    }
    processedCount.current = chunks.length;

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setDisplayText(textRef.current);
      setToolUses([...toolsRef.current]);
      scrollToBottom();
    });

    return () => cancelAnimationFrame(rafRef.current);
  }, [chunks, scrollToBottom]);

  const hasContent = displayText.length > 0 || toolUses.length > 0;

  // 把流式工具调用映射成 ToolCall（暂无 id/output，因为流式只有 input）
  const streamToolCalls: ToolCall[] = toolUses.map((tool, i) => ({
    id: `stream-${i}-${tool.name}`,
    toolName: tool.name,
    kind: classifyToolName(tool.name),
    status: isComplete ? "success" : "running",
    input: (typeof tool.input === "object" && tool.input !== null) ? (tool.input as Record<string, unknown>) : {},
  }));

  // 仅工具调用、无文本时不需要套 muted 气泡
  const assistantHasOnlyTools = toolUses.length > 0 && displayText.length === 0;

  return (
    <div className="px-3 py-2 space-y-2">
      {/* User message bubble */}
      {userMessage && (
        <div className="flex gap-2 w-full justify-end">
          <div className="max-w-[88%] min-w-0 flex flex-col items-end">
            <div className="flex items-center gap-2 mb-0.5 text-[11px]">
              <span className="font-medium text-muted-foreground">{t("sessions.user")}</span>
            </div>
            <div className="rounded-xl px-3 py-2 bg-blue-500 text-white whitespace-pre-wrap break-all overflow-hidden min-w-0 max-w-full" style={{ fontSize: "var(--font-size-prose)" }}>
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
            <div className="rounded-xl px-3 py-2 bg-muted overflow-hidden">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <span className="inline-block w-1.5 h-4 bg-primary animate-pulse" />
                <span>{t("sessions.thinkingDots")}</span>
              </div>
            </div>
          ) : (
            <div className={assistantHasOnlyTools ? "space-y-1.5" : "space-y-1.5"}>
              {displayText && (
                <div className="rounded-xl px-3 py-2 bg-muted overflow-hidden min-w-0 max-w-full">
                  <div className="markdown-prose overflow-hidden">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                      {displayText}
                    </ReactMarkdown>
                    {!isComplete && <span className="inline-block w-1.5 h-4 bg-primary animate-pulse ml-0.5" />}
                  </div>
                </div>
              )}
              {streamToolCalls.length > 0 && (
                <ToolGroup calls={streamToolCalls} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

