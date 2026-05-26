import { useState, useEffect, useRef, useCallback, memo } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { User, Bot, Wrench, ChevronRight, Copy, Check } from "lucide-react";
import { useStreamStore } from "@/hooks/use-stream-store";
import { InlineImages, stripImagePrompt } from "./inline-image";

interface StreamingMessageProps {
  isComplete: boolean;
  userMessage?: string;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  onComplete?: (text: string, tools: Array<{ name: string; input: unknown }>) => void;
}

export const StreamingMessage = memo(function StreamingMessage({ isComplete, userMessage, scrollContainerRef, onComplete }: StreamingMessageProps) {
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

  return (
    <div className="px-4 py-3 space-y-4">
      {/* User message bubble */}
      {userMessage && (
        <div className="flex gap-2.5 w-full justify-end">
          <div className="max-w-[85%] min-w-0 flex flex-col items-end">
            <div className="flex items-center gap-2 mb-1 text-xs">
              <span className="font-medium text-muted-foreground">{t("sessions.user")}</span>
            </div>
            <div className="rounded-xl px-3.5 py-2.5 bg-blue-500 text-white whitespace-pre-wrap break-all overflow-hidden min-w-0 max-w-full" style={{ fontSize: "var(--font-size-prose)" }}>
              <InlineImages text={userMessage} />
              {stripImagePrompt(userMessage)}
            </div>
          </div>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--icon-avatar-user-bg)] text-[var(--icon-avatar-user)] mt-5">
            <User className="h-3.5 w-3.5" />
          </div>
        </div>
      )}

      {/* Assistant streaming response */}
      <div className="flex gap-2.5 w-full justify-start">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--icon-avatar-bot-bg)] text-[var(--icon-avatar-bot)] mt-5">
          <Bot className="h-3.5 w-3.5" />
        </div>
        <div className="max-w-[85%] min-w-0 flex flex-col">
          <div className="flex items-center gap-2 mb-1 text-xs">
            <span className="font-medium text-muted-foreground">{t("sessions.assistant")}</span>
          </div>
          {!hasContent && !isComplete ? (
            <div className="rounded-xl px-3.5 py-2.5 bg-muted overflow-hidden">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <span className="inline-block w-1.5 h-4 bg-primary animate-pulse" />
                <span>{t("sessions.thinkingDots")}</span>
              </div>
            </div>
          ) : (
            <>
              {displayText && (
                <div className="rounded-xl px-3.5 py-2.5 bg-muted overflow-hidden min-w-0 max-w-full">
                  <div className="markdown-prose overflow-hidden">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                      {displayText}
                    </ReactMarkdown>
                    {!isComplete && <span className="inline-block w-1.5 h-4 bg-primary animate-pulse ml-0.5" />}
                  </div>
                </div>
              )}
              {toolUses.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {toolUses.map((tool, i) => (
                    <StreamingToolBlock key={i} name={tool.name} input={tool.input} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
});

function StreamingToolBlock({ name, input }: { name: string; input: unknown }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const inputStr = JSON.stringify(input, null, 2);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(inputStr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 text-sm overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-blue-700 hover:bg-blue-100 transition-colors min-w-0"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronRight className="h-3 w-3 shrink-0 rotate-90" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="font-mono font-medium truncate">[{name}]</span>
      </button>
      {expanded && (
        <div className="border-t border-blue-200 px-3 py-2 relative">
          <button
            onClick={handleCopy}
            className="absolute top-1.5 right-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-blue-400 hover:text-blue-600 hover:bg-blue-100 transition-colors"
            title={t("sessions.copy")}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? t("sessions.copied") : t("sessions.copy")}
          </button>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all text-blue-800 max-h-64 overflow-auto">
            {inputStr}
          </pre>
        </div>
      )}
    </div>
  );
}
