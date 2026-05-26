import { useState, useMemo, useEffect, useDeferredValue, memo, useCallback, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { User, Bot, ChevronDown, ChevronUp, Copy, Check } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Message, ContentBlock } from "@/types";
import { InlineImages, stripImagePrompt } from "./inline-image";
import { ToolGroup, classifyToolName } from "@/components/observability/tool-call-card";
import type { ToolCall } from "@/components/observability/tool-call-card";

interface MessageViewProps {
  messages: Message[];
  initialSearchQuery?: string;
  searchQuery?: string;
  searchNavigation?: MessageSearchNavigation | null;
  onSearchStatusChange?: (status: MessageSearchStatus) => void;
  flat?: boolean;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}

export interface MessageSearchStatus {
  current: number;
  total: number;
}

export interface MessageSearchNavigation {
  direction: 1 | -1;
  nonce: number;
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

/** 单条 ContentBlock 的展示。tool_use/tool_result 在外层做聚合，这里不再处理。 */
function renderBlock(block: ContentBlock, query: string, dark?: boolean, matchOffset?: number, currentMatch?: number): React.ReactNode {
  switch (block.type) {
    case "text":
      return <TextBlock text={block.text} query={query} dark={dark} matchOffset={matchOffset} currentMatch={currentMatch} />;
    case "thinking":
      return <ThinkingBlock block={block} />;
    default:
      return null;
  }
}

/**
 * 把消息内容拆分为「文本/思考块」与「工具调用组」，方便渲染层做 Codex 风格的聚合卡。
 * 连续的 tool_use 块被聚合为同一组；tool_result 用于补全对应 tool_use 的 output，本身不再单独渲染。
 */
type RenderItem =
  | { kind: "block"; block: ContentBlock; blockIndex: number }
  | { kind: "tool-group"; calls: ToolCall[] };

function buildRenderItems(content: ContentBlock[], resultMap: Map<string, string>): RenderItem[] {
  const items: RenderItem[] = [];
  let pending: ToolCall[] = [];

  const flush = () => {
    if (pending.length > 0) {
      items.push({ kind: "tool-group", calls: pending });
      pending = [];
    }
  };

  content.forEach((block, blockIndex) => {
    if (block.type === "tool_use") {
      const id = block.id || `${block.name}-${blockIndex}`;
      const output = resultMap.get(block.id);
      pending.push({
        id,
        toolName: block.name,
        kind: classifyToolName(block.name),
        status: "success",
        input: (typeof block.input === "object" && block.input !== null) ? block.input as Record<string, unknown> : {},
        output,
      });
    } else if (block.type === "tool_result") {
      // 已经通过 resultMap 关联到 tool_use 的 output，跳过单独渲染。
    } else {
      flush();
      items.push({ kind: "block", block, blockIndex });
    }
  });
  flush();
  return items;
}

// ============================================================================
// 跨消息层面：把消息列表预处理为 row 列表
//   - tool-group row：连续仅含 tool_use/tool_result 的助手消息合并为单一 row
//   - message row：其他消息（含文本/思考的助手消息、用户消息）原样保留
// ============================================================================
type RenderRow =
  | { kind: "message"; messageIndex: number }
  | { kind: "tool-group"; startIndex: number; endIndex: number; calls: ToolCall[] };

function isAssistantToolOnlyMessage(msg: Message): boolean {
  if (msg.role !== "assistant" || msg.content.length === 0) return false;
  return msg.content.every((b) => b.type === "tool_use" || b.type === "tool_result");
}

function isUserToolResultOnlyMessage(msg: Message): boolean {
  if (msg.role !== "user" || msg.content.length === 0) return false;
  return msg.content.every((b) => b.type === "tool_result");
}

function buildRenderRows(messages: Message[], resultMap: Map<string, string>): RenderRow[] {
  const rows: RenderRow[] = [];
  let groupStart = -1;
  let groupEnd = -1;
  let groupCalls: ToolCall[] = [];

  const flushGroup = () => {
    if (groupCalls.length === 0) return;
    rows.push({ kind: "tool-group", startIndex: groupStart, endIndex: groupEnd, calls: groupCalls });
    groupStart = -1;
    groupEnd = -1;
    groupCalls = [];
  };

  messages.forEach((msg, i) => {
    const toolOnlyAssistant = isAssistantToolOnlyMessage(msg);
    // 尝试把孤立的 user-tool_result-only 消息也并入当前 pending group
    const userToolResultsOnly = isUserToolResultOnlyMessage(msg);

    if (toolOnlyAssistant) {
      if (groupStart === -1) groupStart = i;
      groupEnd = i;
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          const id = block.id || `${block.name}-${i}`;
          groupCalls.push({
            id,
            toolName: block.name,
            kind: classifyToolName(block.name),
            status: "success",
            input: typeof block.input === "object" && block.input !== null
              ? (block.input as Record<string, unknown>)
              : {},
            output: resultMap.get(block.id),
          });
        }
      }
    } else if (userToolResultsOnly && groupCalls.length > 0) {
      // 把 result 并入当前组（output 已通过 resultMap 找到，无需新增 call）
      groupEnd = i;
    } else {
      flushGroup();
      rows.push({ kind: "message", messageIndex: i });
    }
  });
  flushGroup();
  return rows;
}

/** Row 高度估算。被 measureElement 在挂载后接管为真实高度，此处只需粗估保证初次渲染稳定。 */
function estimateRowSize(row: RenderRow): number {
  if (row.kind === "tool-group") {
    // 折叠后：单卡 ≈ 40，聚合 ≈ 36（仅 header）；预留少量 padding
    return row.calls.length === 1 ? 56 : 52;
  }
  // 普通消息粗估：avatar + header + 一行内容 + copy
  return 110;
}

export const MessageView = memo(function MessageView({
  messages,
  initialSearchQuery,
  searchQuery: externalSearchQuery,
  searchNavigation,
  onSearchStatusChange,
  flat,
  scrollContainerRef,
}: MessageViewProps) {
  const { t } = useTranslation();
  const [localSearchQuery, setLocalSearchQuery] = useState(initialSearchQuery || "");
  const searchQuery = externalSearchQuery ?? localSearchQuery;
  const renderingQuery = useDeferredValue(searchQuery);
  const lastNavigationNonceRef = useRef(searchNavigation?.nonce ?? null);

  useEffect(() => {
    if (externalSearchQuery === undefined) {
      setLocalSearchQuery(initialSearchQuery || "");
    }
  }, [externalSearchQuery, initialSearchQuery]);

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

  // 把消息列表预处理为 row 列表：连续仅含 tool_use/tool_result 的助手消息合并为单一 tool-group row
  const rows = useMemo<RenderRow[]>(() => buildRenderRows(messages, resultMap), [messages, resultMap]);

  const [currentOcc, setCurrentOcc] = useState(0);
  const [scrollTrigger, setScrollTrigger] = useState(0);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef?.current ?? null,
    estimateSize: (i) => estimateRowSize(rows[i]),
    overscan: 8,
    getItemKey: (i) => {
      const row = rows[i];
      if (row.kind === "tool-group") return `tg-${row.startIndex}-${row.endIndex}`;
      return messages[row.messageIndex].timestamp ?? `idx-${row.messageIndex}`;
    },
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

  const navigateMatch = useCallback((dir: 1 | -1) => {
    if (searchState.total === 0) return;
    setCurrentOcc((prev) => (prev + dir + searchState.total) % searchState.total);
    setScrollTrigger((n) => n + 1);
  }, [searchState.total]);

  useEffect(() => {
    if (!searchNavigation || searchNavigation.nonce === lastNavigationNonceRef.current) return;
    lastNavigationNonceRef.current = searchNavigation.nonce;
    navigateMatch(searchNavigation.direction);
  }, [navigateMatch, searchNavigation]);

  useEffect(() => {
    if (!renderingQuery.trim() || searchState.total === 0) {
      onSearchStatusChange?.({ current: 0, total: 0 });
      return;
    }
    onSearchStatusChange?.({ current: currentOcc + 1, total: searchState.total });
  }, [currentOcc, onSearchStatusChange, renderingQuery, searchState.total]);

  // Scroll to the match highlight (按 row index 找含目标 messageIndex 的 row)
  useEffect(() => {
    if (searchState.total === 0 || scrollTrigger === 0) return;
    const msgIdx = searchState.matchToMessage[currentOcc];
    if (msgIdx !== undefined && flat) {
      const rowIdx = rows.findIndex((r) =>
        r.kind === "message"
          ? r.messageIndex === msgIdx
          : msgIdx >= r.startIndex && msgIdx <= r.endIndex
      );
      if (rowIdx !== -1) virtualizer.scrollToIndex(rowIdx, { align: "center" });
    }
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-match-idx="${currentOcc}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
    return () => clearTimeout(timer);
  }, [currentOcc, flat, rows, scrollTrigger, searchState.matchToMessage, searchState.total, virtualizer]);

  const renderRow = useCallback((row: RenderRow) => {
    if (row.kind === "tool-group") {
      // 多消息合并而成的工具组 row：单一卡片占位，左侧 bot 头像
      return (
        <div className="flex gap-2 w-full justify-start">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--icon-avatar-bot-bg)] text-[var(--icon-avatar-bot)] mt-1.5">
            <Bot className="h-3 w-3" />
          </div>
          <div className="max-w-[88%] min-w-0 flex flex-col">
            <ToolGroup calls={row.calls} />
          </div>
        </div>
      );
    }

    const i = row.messageIndex;
    const msg = messages[i];
    const isUser = msg.role === "user";
    const items = buildRenderItems(msg.content, resultMap);
    const hasOnlyTools = !isUser && items.every((it) => it.kind === "tool-group");

    return (
      <div
        className={cn(
          "flex gap-2 w-full",
          isUser ? "justify-end" : "justify-start",
        )}
      >
        {!isUser && (
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--icon-avatar-bot-bg)] text-[var(--icon-avatar-bot)] mt-3.5">
            <Bot className="h-3 w-3" />
          </div>
        )}
        <div className={cn("max-w-[88%] min-w-0 flex flex-col", isUser && "items-end")}>
          <div className="flex items-center gap-2 mb-0.5 text-[11px]">
            <span className="font-medium text-muted-foreground">
              {isUser ? t("sessions.user") : t("sessions.assistant")}
            </span>
            {msg.timestamp && (
              <span className="text-muted-foreground/70">{formatTimestamp(msg.timestamp)}</span>
            )}
          </div>
          <div className={cn(
            "min-w-0 max-w-full space-y-1.5",
            isUser
              ? "rounded-xl px-3 py-2 bg-blue-500 text-white"
              : hasOnlyTools
                ? ""
                : "rounded-xl px-3 py-2 bg-muted",
          )}>
            {isUser && <InlineImages text={extractMessageText(msg)} />}
            {items.map((item, idx) => {
              if (item.kind === "tool-group") {
                return <ToolGroup key={`tg-${idx}`} calls={item.calls} />;
              }
              const block = item.block;
              const offsetKey = `${i}-${item.blockIndex}`;
              return (
                <div key={`b-${item.blockIndex}`} className="overflow-hidden">
                  {renderBlock(block, renderingQuery, isUser, searchState.offsets.get(offsetKey) ?? 0, currentOcc)}
                </div>
              );
            })}
          </div>
          <CopyButton text={extractMessageText(msg)} />
        </div>
        {isUser && (
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--icon-avatar-user-bg)] text-[var(--icon-avatar-user)] mt-3.5">
            <User className="h-3 w-3" />
          </div>
        )}
      </div>
    );
  }, [messages, renderingQuery, searchState.offsets, currentOcc, resultMap, t]);

  const fullMessageList = (
    <div className="space-y-2 p-3 overflow-hidden max-w-full">
      {rows.map((row, idx) => (
        <div key={idx}>{renderRow(row)}</div>
      ))}
    </div>
  );

  const virtualMessageList = (
    <div className="p-3">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const row = rows[virtualItem.index];
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                transform: `translateY(${virtualItem.start}px)`,
                left: 0,
                right: 0,
              }}
              className="pb-2 max-w-full"
            >
              {renderRow(row)}
            </div>
          );
        })}
      </div>
    </div>
  );

  const messageList = flat && scrollContainerRef ? virtualMessageList : fullMessageList;

  // Flat mode: no ScrollArea — parent controls scrolling, search bar sticky at top
  if (flat) {
    return messageList;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0 message-scroll">
        {messageList}
      </ScrollArea>
    </div>
  );
});
