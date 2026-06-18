import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import type { ContentBlock, Message } from "@/types";
import { InlineImages, stripImagePrompt } from "./inline-image";
import { ToolGroup, classifyToolName } from "@/components/observability/tool-call-card";
import type { ToolCall } from "@/components/observability/tool-call-card";
import { InteractionCard } from "./interaction-card";
import { isInteractionToolName, looksLikeInteractionToolInput } from "@/lib/interaction-tools";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

// Native "poor man's virtualization": the browser skips layout/paint for rows
// outside the viewport while keeping them in the DOM (search/highlight/scroll
// stay intact). `auto` lets the browser remember each row's real rendered size,
// so the scrollbar stays accurate; 200px is only the never-yet-rendered guess.
const ROW_STYLE: React.CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 200px",
};

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

type RenderItem =
  | { kind: "block"; block: ContentBlock; messageIndex: number; blockIndex: number }
  | { kind: "tool-group"; calls: ToolCall[] };

type RenderRow =
  | { kind: "user"; messageIndex: number }
  | { kind: "assistant"; startIndex: number; endIndex: number; messageIndices: number[] };

function highlightText(text: string, query: string, matchOffset: number, currentMatch: number): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  let localIdx = 0;

  return parts.map((part, i) => {
    if (part.toLowerCase() !== query.toLowerCase()) return part;
    const globalIdx = matchOffset + localIdx;
    localIdx++;
    return (
      <mark
        key={i}
        data-match-idx={globalIdx}
        className={cn(
          "rounded px-0.5",
          globalIdx === currentMatch ? "bg-yellow-300 ring-1 ring-yellow-500" : "bg-yellow-100",
        )}
      >
        {part}
      </mark>
    );
  });
}

const ThinkingBlock = memo(function ThinkingBlock({ block }: { block: ContentBlock & { type: "thinking" } }) {
  const { t } = useTranslation();

  return (
    <details className="rounded-[6px] border border-border/40 bg-[var(--message-thinking-bg)] px-2.5 py-1.5 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none hover:text-foreground">
        {t("sessions.showThinking")}
      </summary>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
        {block.thinking}
      </pre>
    </details>
  );
});

const TextBlock = memo(function TextBlock({
  text,
  query,
  dark,
  matchOffset,
  currentMatch,
}: {
  text: string;
  query: string;
  dark?: boolean;
  matchOffset?: number;
  currentMatch?: number;
}) {
  if (dark) {
    const display = stripImagePrompt(text);
    return (
      <div className="whitespace-pre-wrap break-all overflow-hidden" style={{ fontSize: "var(--font-size-prose)" }}>
        {query ? highlightText(display, query, matchOffset ?? 0, currentMatch ?? -1) : display}
      </div>
    );
  }

  if (query.trim()) {
    return (
      <div className="markdown-prose overflow-hidden whitespace-pre-wrap break-words text-sm">
        {highlightText(text, query, matchOffset ?? 0, currentMatch ?? -1)}
      </div>
    );
  }

  return (
    <div className="markdown-prose overflow-hidden">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

function extractMessageText(msg: Message): string {
  return msg.content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "tool_use":
          return `[${block.name}]\n${JSON.stringify(block.input, null, 2)}`;
        case "tool_result":
          return typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2);
        case "thinking":
          return block.thinking;
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

function extractMessagesText(messages: Message[], indices: number[]): string {
  return indices.map((i) => extractMessageText(messages[i])).filter(Boolean).join("\n\n");
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => clearTimeout(timerRef.current);
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(text);
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
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

function renderBlock(
  block: ContentBlock,
  query: string,
  dark?: boolean,
  matchOffset?: number,
  currentMatch?: number,
): React.ReactNode {
  switch (block.type) {
    case "text":
      return <TextBlock text={block.text} query={query} dark={dark} matchOffset={matchOffset} currentMatch={currentMatch} />;
    case "thinking":
      return <ThinkingBlock block={block} />;
    case "interaction":
      return (
        <InteractionCard
          items={(block as any).items}
          prompt={block.prompt}
          options={block.options}
          answer={block.answer}
          selectedOptions={block.selected_options}
          origin={block.origin}
        />
      );
    default:
      return null;
  }
}

function isUserToolResultOnlyMessage(msg: Message): boolean {
  if (msg.role !== "user" || msg.content.length === 0) return false;
  return msg.content.every((block) => block.type === "tool_result");
}

function buildRenderRows(messages: Message[]): RenderRow[] {
  const rows: RenderRow[] = [];
  let assistantGroup: RenderRow & { kind: "assistant" } | null = null;

  const flushAssistant = () => {
    if (!assistantGroup) return;
    rows.push(assistantGroup);
    assistantGroup = null;
  };

  messages.forEach((msg, i) => {
    if (msg.role === "assistant") {
      if (!assistantGroup) {
        assistantGroup = { kind: "assistant", startIndex: i, endIndex: i, messageIndices: [i] };
      } else {
        assistantGroup.endIndex = i;
        assistantGroup.messageIndices.push(i);
      }
      return;
    }

    if (isUserToolResultOnlyMessage(msg) && assistantGroup) {
      assistantGroup.endIndex = i;
      assistantGroup.messageIndices.push(i);
      return;
    }

    flushAssistant();
    rows.push({ kind: "user", messageIndex: i });
  });

  flushAssistant();
  return rows;
}

const isInteractionTool = (name: string, input: any) => {
  return isInteractionToolName(name) || looksLikeInteractionToolInput(input);
};

function buildRenderItemsForMessages(messages: Message[], messageIndices: number[], resultMap: Map<string, string>): RenderItem[] {
  const items: RenderItem[] = [];
  let pendingTools: ToolCall[] = [];
  const hasPersistedInteraction = messageIndices.some((messageIndex) =>
    messages[messageIndex].content.some((block) => block.type === "interaction"),
  );

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    items.push({ kind: "tool-group", calls: pendingTools });
    pendingTools = [];
  };

  for (const messageIndex of messageIndices) {
    const message = messages[messageIndex];
    message.content.forEach((block, blockIndex) => {
      if (block.type === "tool_use") {
        if (isInteractionTool(block.name, block.input)) {
          flushTools();
          if (hasPersistedInteraction) {
            return;
          }
          const inputObj = (block.input && typeof block.input === "object") ? (block.input as any) : {};
          const rawPrompt = inputObj.question || inputObj.prompt || "";
          const rawOptions = Array.isArray(inputObj.options) ? inputObj.options : [];
          const rawAnswer = resultMap.get(block.id) || "";

          const parsedOptions = rawOptions.map((opt: any) => {
            if (typeof opt === "string") {
              return { option_id: opt, label: opt };
            }
            return {
              option_id: opt.option_id || opt.id || "",
              label: opt.label || opt.text || opt.label || "",
              description: opt.description,
            };
          });

          const normalizedName = block.name.split('/').pop()?.split(':').pop()?.replace(/-/g, '_').toLowerCase() || "";
          const isAcp = normalizedName === "askuserquestion" || normalizedName === "ask_user_question";
          const origin = isAcp ? "acp_elicitation" : "extension_ui";

          items.push({
            kind: "block",
            block: {
              type: "interaction",
              prompt: rawPrompt,
              options: parsedOptions,
              answer: rawAnswer,
              origin,
            },
            messageIndex,
            blockIndex,
          });
          return;
        }

        const id = block.id || `${block.name}-${messageIndex}-${blockIndex}`;
        pendingTools.push({
          id,
          toolName: block.name,
          kind: classifyToolName(block.name),
          status: "success",
          input: typeof block.input === "object" && block.input !== null
            ? (block.input as Record<string, unknown>)
            : {},
          output: resultMap.get(block.id),
        });
        return;
      }

      if (block.type === "tool_result") return;

      flushTools();
      items.push({ kind: "block", block, messageIndex, blockIndex });
    });
  }

  flushTools();

  // Group consecutive interaction blocks in the same message segment
  const groupedItems: RenderItem[] = [];
  for (const item of items) {
    if (item.kind === "block" && item.block.type === "interaction") {
      const last = groupedItems[groupedItems.length - 1];
      if (last && last.kind === "block" && last.block.type === "interaction") {
        const lastBlock = last.block as any;
        if (!lastBlock.items) {
          lastBlock.items = [
            {
              prompt: lastBlock.prompt,
              options: lastBlock.options,
              answer: lastBlock.answer,
              selectedOptions: lastBlock.selected_options,
            }
          ];
        }
        lastBlock.items.push({
          prompt: item.block.prompt,
          options: item.block.options,
          answer: item.block.answer,
          selectedOptions: item.block.selected_options,
        });
        continue;
      }
    }
    groupedItems.push(item);
  }

  return groupedItems;
}

function rowKey(row: RenderRow, messages: Message[]): string {
  if (row.kind === "user") {
    const msg = messages[row.messageIndex];
    const text = extractMessageText(msg);
    return `user-${row.messageIndex}-${text.length}-${text.slice(0, 16)}`;
  }

  const text = extractMessagesText(messages, row.messageIndices);
  return `assistant-${row.startIndex}-${row.endIndex}-${row.messageIndices.length}-${text.length}-${text.slice(0, 16)}`;
}

function AssistantBubble({
  items,
  copyText,
  renderingQuery,
  searchOffsets,
  currentOcc,
}: {
  items: RenderItem[];
  copyText: string;
  renderingQuery: string;
  searchOffsets: Map<string, number>;
  currentOcc: number;
}) {
  const { t } = useTranslation();

  return (
    <div className="w-full">
      <div className="max-w-full min-w-0 flex flex-col">
        <div className="flex items-center gap-2 mb-0.5 text-[11px]">
          <span className="font-medium text-muted-foreground">{t("sessions.assistant")}</span>
        </div>
        <div className="min-w-0 max-w-full space-y-2 rounded-xl px-3 py-2 bg-[var(--message-assistant-bg)] text-[var(--message-assistant-fg)]">
          {items.map((item, idx) => {
            if (item.kind === "tool-group") {
              return (
                <div key={`tg-${idx}`} className="rounded-[8px]">
                  <ToolGroup calls={item.calls} />
                </div>
              );
            }

            const offsetKey = `${item.messageIndex}-${item.blockIndex}`;
            return (
              <div key={`b-${item.messageIndex}-${item.blockIndex}`} className="overflow-hidden">
                {renderBlock(
                  item.block,
                  renderingQuery,
                  false,
                  searchOffsets.get(offsetKey) ?? 0,
                  currentOcc,
                )}
              </div>
            );
          })}
        </div>
        <div className="self-start">
          <CopyButton text={copyText} />
        </div>
      </div>
    </div>
  );
}

function UserBubble({
  msg,
  items,
  renderingQuery,
  searchOffsets,
  currentOcc,
  messageIndex,
}: {
  msg: Message;
  items: RenderItem[];
  renderingQuery: string;
  searchOffsets: Map<string, number>;
  currentOcc: number;
  messageIndex: number;
}) {
  const { t } = useTranslation();
  const copyText = extractMessageText(msg);

  return (
    <div className="w-full flex justify-end">
      <div className="max-w-[88%] min-w-0 flex flex-col items-end">
        <div className="flex items-center gap-2 mb-0.5 text-[11px]">
          <span className="font-medium text-muted-foreground">{t("sessions.user")}</span>
        </div>
        <div className="min-w-0 max-w-full space-y-1.5 rounded-xl px-3 py-2 bg-[var(--message-user-bg)] text-[var(--message-user-fg)]">
          <InlineImages text={copyText} />
          {items.map((item, idx) => {
            if (item.kind === "tool-group") {
              return <ToolGroup key={`tg-${idx}`} calls={item.calls} />;
            }

            const offsetKey = `${messageIndex}-${item.blockIndex}`;
            return (
              <div key={`b-${item.blockIndex}`} className="overflow-hidden">
                {renderBlock(
                  item.block,
                  renderingQuery,
                  true,
                  searchOffsets.get(offsetKey) ?? 0,
                  currentOcc,
                )}
              </div>
            );
          })}
        </div>
        <div className="self-end">
          <CopyButton text={copyText} />
        </div>
      </div>
    </div>
  );
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
        const count = block.text.match(regex)?.length ?? 0;
        for (let i = 0; i < count; i++) matchToMessage.push(mi);
        total += count;
      });
    });

    return { total, offsets, matchToMessage };
  }, [messages, renderingQuery]);

  const resultMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        map.set(block.tool_use_id, content);
      }
    }
    return map;
  }, [messages]);

  const rows = useMemo<RenderRow[]>(() => buildRenderRows(messages), [messages]);
  const [currentOcc, setCurrentOcc] = useState(0);
  const [scrollTrigger, setScrollTrigger] = useState(0);

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

  useEffect(() => {
    if (searchState.total === 0 || scrollTrigger === 0) return;
    // If the target match is already rendered and fully inside the viewport,
    // just let the highlight move (driven by currentOcc) without scrolling —
    // avoids the jarring scroll-up-then-back jump when navigating between
    // matches that are already visible together on screen.
    const container = scrollContainerRef?.current;
    const visibleEl = document.querySelector(`[data-match-idx="${currentOcc}"]`);
    if (container && visibleEl) {
      const er = visibleEl.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      if (er.top >= cr.top && er.bottom <= cr.bottom) return;
    }
    const msgIdx = searchState.matchToMessage[currentOcc];
    if (msgIdx === undefined) return;
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-match-idx="${currentOcc}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
    return () => clearTimeout(timer);
  }, [currentOcc, scrollTrigger, searchState.matchToMessage, searchState.total]);

  const renderRow = useCallback((row: RenderRow) => {
    if (row.kind === "assistant") {
      const items = buildRenderItemsForMessages(messages, row.messageIndices, resultMap);
      return (
        <AssistantBubble
          items={items}
          copyText={extractMessagesText(messages, row.messageIndices)}
          renderingQuery={renderingQuery}
          searchOffsets={searchState.offsets}
          currentOcc={currentOcc}
        />
      );
    }

    const msg = messages[row.messageIndex];
    const items = buildRenderItemsForMessages(messages, [row.messageIndex], resultMap);
    return (
      <UserBubble
        msg={msg}
        items={items}
        renderingQuery={renderingQuery}
        searchOffsets={searchState.offsets}
        currentOcc={currentOcc}
        messageIndex={row.messageIndex}
      />
    );
  }, [currentOcc, messages, renderingQuery, resultMap, searchState.offsets]);

  const fullMessageList = (
    <div className="mx-auto w-full max-w-[var(--message-content-max-width)] space-y-2 px-4 py-3">
      {rows.map((row) => (
        <div key={rowKey(row, messages)} style={ROW_STYLE}>{renderRow(row)}</div>
      ))}
    </div>
  );

  if (flat) return fullMessageList;

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="flex-1 min-h-0 message-scroll">
        {fullMessageList}
      </ScrollArea>
    </div>
  );
});
