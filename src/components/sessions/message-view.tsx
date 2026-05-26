import { useState, useMemo, useEffect, useDeferredValue, memo, useCallback } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { User, Bot, Wrench, ChevronDown, ChevronUp, ChevronRight, Search, ArrowDown, ArrowUp, RotateCw, Copy, Check, X } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Message, ContentBlock } from "@/types";
import { InlineImages, stripImagePrompt } from "./inline-image";
import { ToolCallCard, classifyToolName } from "@/components/observability/tool-call-card";
import type { ToolCall } from "@/components/observability/tool-call-card";

interface MessageViewProps {
  messages: Message[];
  initialSearchQuery?: string;
  onRefresh?: () => void;
  flat?: boolean;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString();
}

function highlightText(text: string, query: string, matchOffset: number, currentMatch: number): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  let localIdx = 0;
  return parts.map((part, i) => {
    if (part.toLowerCase() === query.toLowerCase()) {
      const globalIdx = matchOffset + localIdx;
      localIdx++;
      const isCurrent = globalIdx === currentMatch;
      return (
        <mark key={i} data-match-idx={globalIdx} className={cn(
          "rounded px-0.5",
          isCurrent ? "bg-yellow-300 ring-1 ring-yellow-500" : "bg-yellow-100"
        )}>{part}</mark>
      );
    }
    return part;
  });
}

const ToolUseBlock = memo(function ToolUseBlock({ block, query, dark }: { block: ContentBlock & { type: "tool_use" }; query: string; dark?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const inputStr = JSON.stringify(block.input, null, 2);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="overflow-hidden">
      <div className={cn(
        "rounded-md border text-sm",
        dark ? "border-blue-300/50 bg-blue-400/30" : "border-blue-200 bg-blue-50"
      )}>
        <CollapsibleTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors min-w-0",
              dark ? "text-blue-100 hover:bg-blue-400/40" : "text-blue-700 hover:bg-blue-100"
            )}
          >
            {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
            <Wrench className="h-3 w-3 shrink-0" />
            <span className="font-mono font-medium truncate">[{block.name}]</span>
          </button>
        </CollapsibleTrigger>
        {expanded && (
          <pre className={cn(
            "px-3 py-2 border-t text-xs font-mono whitespace-pre-wrap break-all max-h-64 overflow-auto",
            dark
              ? "border-blue-300/30 text-blue-100 bg-black/10"
              : "border-blue-200 text-blue-800 bg-blue-50/50"
          )}>
            {query ? highlightText(inputStr, query, 0, -1) : inputStr}
          </pre>
        )}
      </div>
    </Collapsible>
  );
});

const ToolResultBlock = memo(function ToolResultBlock({ block, query, dark }: { block: ContentBlock & { type: "tool_result" }; query: string; dark?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const contentStr = typeof block.content === "string"
    ? block.content
    : JSON.stringify(block.content, null, 2);
  const displayText = expanded ? contentStr : contentStr.slice(0, 500);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="overflow-hidden">
      <div className={cn(
        "rounded-md border text-sm",
        dark ? "border-amber-300/50 bg-amber-400/30" : "border-amber-200 bg-amber-50"
      )}>
        <CollapsibleTrigger asChild>
          <div
            className={cn(
              "flex items-center gap-1 px-3 py-1.5 text-xs font-medium cursor-pointer select-none",
              dark ? "text-amber-100 hover:bg-amber-400/40" : "text-amber-700 hover:bg-amber-100"
            )}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            [Result]
          </div>
        </CollapsibleTrigger>
        {expanded && (
          <pre className={cn(
            "px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all max-h-64 overflow-auto",
            dark ? "text-amber-100" : "text-amber-800"
          )}>
            {query ? highlightText(displayText, query, 0, -1) : displayText}
          </pre>
        )}
      </div>
    </Collapsible>
  );
});

const ThinkingBlock = memo(function ThinkingBlock({ block }: { block: ContentBlock & { type: "thinking" } }) {
  const { t } = useTranslation();

  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground text-xs select-none">
        {t("sessions.showThinking")}
      </summary>
      <pre className="mt-1 rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-all text-muted-foreground max-h-64 overflow-auto">
        {block.thinking}
      </pre>
    </details>
  );
});

const TextBlock = memo(function TextBlock({ text, query, dark, matchOffset, currentMatch }: { text: string; query: string; dark?: boolean; matchOffset?: number; currentMatch?: number }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const needsCollapse = text.length > 800;

  // User messages: plain text (strip image prompt lines)
  if (dark) {
    const display = stripImagePrompt(text);
    return (
      <div className="whitespace-pre-wrap break-all overflow-hidden" style={{ fontSize: "var(--font-size-prose)" }}>
        {query ? highlightText(display, query, matchOffset ?? 0, currentMatch ?? -1) : display}
      </div>
    );
  }

  // Assistant messages with search: highlight text (skip markdown during search)
  if (query.trim()) {
    return (
      <div className="markdown-prose overflow-hidden whitespace-pre-wrap break-words text-sm">
        {highlightText(text, query, matchOffset ?? 0, currentMatch ?? -1)}
      </div>
    );
  }

  // Assistant messages: markdown rendering
  const content = (
    <div className="markdown-prose overflow-hidden">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </ReactMarkdown>
    </div>
  );

  if (!needsCollapse) {
    return content;
  }

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="overflow-hidden">
      <div className="relative">
        <div className={cn("overflow-hidden", !expanded && "max-h-48")}>
          {content}
        </div>
        {!expanded && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-muted/90 to-transparent" />
        )}
      </div>
      <CollapsibleTrigger asChild>
        <button className="mt-1 inline-flex items-center gap-1 rounded-full px-3 py-0.5 text-xs text-foreground/60 hover:text-foreground hover:bg-muted transition-colors">
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {expanded ? t("sessions.collapse") : t("sessions.expand")}
        </button>
      </CollapsibleTrigger>
    </Collapsible>
  );
});

function extractMessageText(msg: Message): string {
  return msg.content.map(block => {
    switch (block.type) {
      case "text": return block.text;
      case "tool_use": return `[${block.name}]\n${JSON.stringify(block.input, null, 2)}`;
      case "tool_result": return typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2);
      case "thinking": return block.thinking;
      default: return "";
    }
  }).filter(Boolean).join("\n\n");
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 mt-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      title={t("sessions.copy")}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? t("sessions.copied") : t("sessions.copy")}
    </button>
  );
}

function renderBlock(block: ContentBlock, query: string, dark?: boolean, matchOffset?: number, currentMatch?: number, _resultMap?: Map<string, string>): React.ReactNode {
  switch (block.type) {
    case "text":
      return <TextBlock text={block.text} query={query} dark={dark} matchOffset={matchOffset} currentMatch={currentMatch} />;
    case "tool_use": {
      const resultMap = _resultMap;
      const toolCall: ToolCall = {
        id: block.id || block.name,
        toolName: block.name,
        kind: classifyToolName(block.name),
        status: resultMap?.has(block.id) ? "success" : "success",
        input: (typeof block.input === "object" && block.input !== null) ? block.input as Record<string, unknown> : {},
        output: resultMap?.get(block.id),
        startedAt: undefined,
        endedAt: undefined,
      };
      return <ToolCallCard call={toolCall} />;
    }
    case "tool_result":
      return <ToolResultBlock block={block} query={query} dark={dark} />;
    case "thinking":
      return <ThinkingBlock block={block} />;
    default:
      return null;
  }
}

export const MessageView = memo(function MessageView({ messages, initialSearchQuery, onRefresh, flat, scrollContainerRef }: MessageViewProps) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery || "");
  const renderingQuery = useDeferredValue(searchQuery);

  useEffect(() => {
    setSearchQuery(initialSearchQuery || "");
  }, [initialSearchQuery]);

  const searchState = useMemo(() => {
    if (!renderingQuery.trim()) return { total: 0, offsets: new Map<string, number>(), matchToMessage: [] as number[] };
    const escaped = renderingQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    const offsets = new Map<string, number>();
    const matchToMessage: number[] = [];
    let total = 0;
    messages.forEach((msg, mi) => {
      msg.content.forEach((block, bi) => {
        if (block.type !== "text") return;
        offsets.set(`${mi}-${bi}`, total);
        const m = block.text.match(regex);
        const count = m ? m.length : 0;
        for (let k = 0; k < count; k++) matchToMessage.push(mi);
        total += count;
      });
    });
    return { total, offsets, matchToMessage };
  }, [messages, renderingQuery]);

  // Build a map from tool_use_id to tool_result content for ToolCallCard integration
  const resultMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const content = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
          map.set(block.tool_use_id, content);
        }
      }
    }
    return map;
  }, [messages]);

  const [currentOcc, setCurrentOcc] = useState(0);
  const [scrollTrigger, setScrollTrigger] = useState(0);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollContainerRef?.current ?? null,
    estimateSize: (i) => {
      const msg = messages[i];
      let h = 0;
      for (const block of msg.content) {
        switch (block.type) {
          case "text": {
            const t = block.text;
            const lines = (t.match(/\n/g)?.length ?? 0) + Math.ceil(t.length / 55);
            h += lines * 22;
            const codeBlockCount = (t.match(/```/g)?.length ?? 0) >> 1;
            h += codeBlockCount * 60;
            break;
          }
          case "tool_use":
          case "tool_result": {
            const json = JSON.stringify(block.type === "tool_use" ? (block as ContentBlock & { type: "tool_use" }).input : (block as ContentBlock & { type: "tool_result" }).content);
            h += Math.max(44, Math.min(140, json.length / 4 + 36));
            break;
          }
          case "thinking":
            h += 28;
            break;
        }
      }
      // avatar(28) + header(20) + bubble-pad(20) + copy-btn(24) + margin(16)
      return Math.max(72, h + 108);
    },
    overscan: 15,
    getItemKey: (i) => messages[i].timestamp ?? `idx-${i}`,
  });

  // When search query changes, auto-scroll to first match
  useEffect(() => {
    if (!renderingQuery.trim() || searchState.total === 0) {
      setCurrentOcc(0);
      return;
    }
    setCurrentOcc(0);
    setScrollTrigger((n) => n + 1);
  }, [renderingQuery, searchState.total]);

  const navigateMatch = (dir: 1 | -1) => {
    if (searchState.total === 0) return;
    setCurrentOcc((prev) => (prev + dir + searchState.total) % searchState.total);
    setScrollTrigger((n) => n + 1);
  };

  // Scroll to the match highlight
  useEffect(() => {
    if (searchState.total === 0 || scrollTrigger === 0) return;
    const msgIdx = searchState.matchToMessage[currentOcc];
    if (msgIdx !== undefined && flat) {
      virtualizer.scrollToIndex(msgIdx, { align: "center" });
    }
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-match-idx="${currentOcc}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
    return () => clearTimeout(timer);
  }, [scrollTrigger]);

  const renderMessage = useCallback((msg: Message, i: number) => {
    const isUser = msg.role === "user";
    return (
      <div
        className={cn(
          "flex gap-2.5 w-full",
          isUser ? "justify-end" : "justify-start",
        )}
      >
        {!isUser && (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--icon-avatar-bot-bg)] text-[var(--icon-avatar-bot)] mt-5">
            <Bot className="h-3.5 w-3.5" />
          </div>
        )}
        <div className={cn("max-w-[85%] min-w-0 flex flex-col", isUser && "items-end")}>
          <div className="flex items-center gap-2 mb-1 text-xs">
            <span className="font-medium text-muted-foreground">
              {isUser ? t("sessions.user") : t("sessions.assistant")}
            </span>
            {msg.timestamp && (
              <span className="text-muted-foreground">{formatTimestamp(msg.timestamp)}</span>
            )}
          </div>
          <div className={cn(
            "rounded-xl px-3.5 py-2.5 space-y-2 overflow-hidden min-w-0 max-w-full",
            isUser ? "bg-blue-500 text-white" : "bg-muted"
          )}>
            {isUser && <InlineImages text={extractMessageText(msg)} />}
            {msg.content.map((block, j) => (
              <div key={j} className="overflow-hidden">
                {renderBlock(block, renderingQuery, isUser, searchState.offsets.get(`${i}-${j}`) ?? 0, currentOcc, resultMap)}
              </div>
            ))}
          </div>
          <CopyButton text={extractMessageText(msg)} />
        </div>
        {isUser && (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--icon-avatar-user-bg)] text-[var(--icon-avatar-user)] mt-5">
            <User className="h-3.5 w-3.5" />
          </div>
        )}
      </div>
    );
  }, [renderingQuery, searchState.offsets, currentOcc, resultMap, t]);

  const fullMessageList = (
    <div className="space-y-4 p-4 overflow-hidden max-w-full">
      {messages.map((msg, i) => (
        <div key={i}>{renderMessage(msg, i)}</div>
      ))}
    </div>
  );

  const virtualMessageList = (
    <div className="p-4">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const msg = messages[virtualItem.index];
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              style={{
                position: "absolute",
                top: 0,
                transform: `translateY(${virtualItem.start}px)`,
                left: 0,
                right: 0,
              }}
              className="pb-4 max-w-full"
            >
              {renderMessage(msg, virtualItem.index)}
            </div>
          );
        })}
      </div>
    </div>
  );

  const messageList = flat && scrollContainerRef ? virtualMessageList : fullMessageList;

  // Flat mode: no ScrollArea — parent controls scrolling, search bar sticky at top
  if (flat) {
    return (
      <>
        <div className="sticky top-0 z-10 border-b border-border/30 px-4 py-2 flex items-center gap-2" style={{ background: "var(--color-layer-4)" }}>
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--icon-search)]" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("sessions.search")}
              className="h-8 pl-8 pr-7 text-sm"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          {searchState.total > 0 && (
            <div className="flex items-center gap-0">
              <span className="text-xs text-muted-foreground whitespace-nowrap pr-1">
                {currentOcc + 1}/{searchState.total}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => navigateMatch(-1)}
              >
                <ArrowUp className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => navigateMatch(1)}
              >
                <ArrowDown className="h-3 w-3" />
              </Button>
            </div>
          )}
          {renderingQuery && searchState.total === 0 && (
            <span className="text-xs text-muted-foreground">{t("sessions.noResults")}</span>
          )}
          {onRefresh && (
            <Button variant="ghost" size="icon-xs" onClick={onRefresh}>
              <RotateCw className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        {messageList}
      </>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Search bar */}
      <div className="border-b border-border px-4 py-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("sessions.search")}
            className="h-8 pl-8 pr-7 text-sm"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {searchState.total > 0 && (
          <div className="flex items-center gap-0">
            <span className="text-xs text-muted-foreground whitespace-nowrap pr-1">
              {currentOcc + 1}/{searchState.total}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => navigateMatch(-1)}
            >
              <ArrowUp className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => navigateMatch(1)}
            >
              <ArrowDown className="h-3 w-3" />
            </Button>
          </div>
        )}
        {searchQuery && searchState.total === 0 && (
          <span className="text-xs text-muted-foreground">{t("sessions.noResults")}</span>
        )}
        {onRefresh && (
          <Button variant="ghost" size="icon-xs" onClick={onRefresh}>
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0 message-scroll">
        {messageList}
      </ScrollArea>
    </div>
  );
});
