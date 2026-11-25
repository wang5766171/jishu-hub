import { Fragment, createContext, memo, useCallback, useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { devLog } from "@/lib/dev-log";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, Bot, Pencil, Trash2 } from "lucide-react";
import type { ContentBlock, Message } from "@/types";
import { InlineImages, stripImagePrompt } from "./inline-image";
import { blockSearchText, countMatches, searchRegExp } from "@/lib/session-search-text";
import { SearchHighlightRegistry, centerInScroller, findMatchRanges, rectOfMatch, scrollTopToCenter, supportsTextHighlight } from "./search-highlight";
import { extractCodeText } from "./code-block-text";
// v0.9.7 需求6 F2：产物引用链接（jishu-artifact://）——Q14：仅助手消息两处接入。
import { jishuUrlTransform } from "@/lib/markdown-url";
import { ArtifactLink } from "./artifact-link";
import { EmbeddedToolPills, UserTextWithPills, hasKnownToolToken, scanToolIdsFromText, useSessionToolCats, useSessionToolNames } from "./embedded-tools";
import { computeRetriedSuccessFlags } from "@/lib/retry-flag";
import { ToolGroup } from "@/components/observability/tool-call-card";
import { resolveToolKind } from "@/components/observability/tool-call-card/types";
import type { ToolCall } from "@/components/observability/tool-call-card";
import { InteractionBlockWithRenderers as InteractionBlock } from "./interaction-card";
import type { InteractionCardItem } from "./interaction-card";
import { isInteractionToolName, looksLikeInteractionToolInput } from "@/lib/interaction-tools";
import { PhaseDivider } from "./conversation-content";
// v0.9.8 需求5（合并版）：装备推荐块——助手文本中的 <JISHU-EQUIP-RECOMMEND>
// 块渲染为可安装推荐卡（直播/回放同链路：块留在消息文本里）。
import {
  EquipRecommendCard,
  EquipSessionContext,
  extractEquipSegments,
} from "./equip-recommend-card";
// v0.9.2 需求1 P1：行/轮次语义迁移至会话内核统一视图模型（单一权威，
// 导航轨等轮次消费方读同一份，消除双实现契约对齐负担）。
import { buildSearchDisplayItems, buildSessionRows, isUserToolResultOnlyMessage, type SearchDisplayItem, type SearchGapPosition, type SessionRowModel } from "@/features/session-kernel/view-model";
// v0.9.5 需求4 P2：轮级三段式（已工作折叠 + 正文 + 文件改动概览）。
import { buildTurnSegments } from "@/features/session-kernel/view-model/build-turn-segments";
import { TurnGroupView } from "@/features/session-kernel/shell/turn-group-view";
// v0.9.2 需求1 M4：块渲染器咨询点（HTML/Mermaid 等插件经 Context 接管代码块）。
import {
  matchBlockRenderer,
  matchBlockTypeRenderer,
  useBlockRenderers,
} from "@/features/session-kernel/plugins/mounts/use-block-renderers";

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

// v0.9.8 需求23：会话内搜索——渲染后标黄 + 只显示命中消息。
//
// `active` 为真时（正在搜索且浏览器支持文字高亮接口），文字块照常渲染成
// Markdown，由 SearchHighlightArea 在渲染好的页面上登记命中范围并上色；
// 为假时文字块回落到原先的「源码切分加 <mark>」方式（高亮接口不可用的环境）。
type SearchHighlightContextValue = {
  registry: SearchHighlightRegistry;
  active: boolean;
  query: string;
  /** 文字块 → 该块第一处命中的全局序号（`${消息下标}-${块下标}`）。 */
  offsets: Map<string, number>;
  /** 含命中的文字块（`${消息下标}-${块下标}`）——只有这些块需要到页面上找命中。 */
  hitBlocks: Set<string>;
};
const SearchHighlightContext = createContext<SearchHighlightContextValue>({
  registry: new SearchHighlightRegistry(),
  active: false,
  query: "",
  offsets: new Map(),
  hitBlocks: new Set(),
});

/**
 * 「高亮接口是否生效」单独一份：文字块只读这一项。上面那份带搜索词，搜索词每变
 * 一次订阅它的组件都会重渲染——长会话里就是每敲一个字把所有行重新渲染一遍。
 */
const SearchHighlightModeContext = createContext(false);

/** 「上一处 / 下一处」切换时传给文字块的固定值：高亮接口生效时当前命中靠登记处上色，文字块不必重渲染。 */
const NO_CURRENT_MATCH = -1;

/**
 * 高亮接口生效时，行的渲染结果不依赖搜索词（命中在渲染后登记上色）。给行的搜索
 * 属性用这份固定值，搜索词变化时已显示的行才能跳过重渲染。
 */
const EMPTY_OFFSETS: Map<string, number> = new Map();
const EMPTY_ITEMS: RenderItem[] = [];

/** v0.9.8 需求23：搜索跳转信号（页面 → 消息视图）：目标会话 + 递增序号。 */
export type SearchJump = { sessionId: string | null; nonce: number };

/**
 * v0.9.8 需求23：搜索态下记住「视口顶上是哪条消息行、离视口顶多远」。搜索态
 * 只显示命中行，退出时上下的消息重新补进来——按这个把那条行放回屏幕原处，
 * 正在看的内容不动。停在底部时记「底部」。
 */
type LensAnchor = { kind: "bottom" } | { kind: "row"; messageIndex: number; offset: number };

/**
 * 让指定的行按真实高度参与布局后再量。
 *
 * 消息行用了 content-visibility: auto——浏览器还没决定渲染的行不排版，高度是占位值
 * （contain-intrinsic-size 的 auto 200px），渲染后才变成真实高度。刚补进列表的行，
 * 在布局副作用里量的就是占位高度：按它补的滚动位置，等浏览器把行渲染出来就偏了
 * （开发实例实测偏 88 像素）。这里先强制排版再量；量完恢复，浏览器会记住这次量到的
 * 真实尺寸，之后跳过排版时用的也是真实高度。
 */
function withRenderedRows<T>(rowEls: HTMLElement[], measure: () => T): T {
  // 记下原来的行内值再改：量完要还原成原值（置空会把 content-visibility: auto 删掉，
  // 这一行此后不再被浏览器跳过排版）
  const previous = rowEls.map((el) => el.style.getPropertyValue("content-visibility"));
  for (const el of rowEls) el.style.setProperty("content-visibility", "visible");
  try {
    return measure();
  } finally {
    rowEls.forEach((el, i) => {
      if (previous[i]) el.style.setProperty("content-visibility", previous[i]);
      else el.style.removeProperty("content-visibility");
    });
  }
}

/**
 * 随后几帧继续对齐一个滚动位置（align 返回「还要滚多少」）。
 * 视口边缘的行会被浏览器陆续渲染、高度还会变，刚放好的位置可能被顶偏一点，这里跟着补。
 * 滚动位置一旦被别处改动（用户滚动、其他定位）就停——不跟用户抢滚动。
 */
function holdScrollForFrames(container: HTMLElement, align: () => number, frames = 4): void {
  if (typeof requestAnimationFrame !== "function") return;
  let expected = container.scrollTop;
  let left = frames;
  const tick = () => {
    if (Math.abs(container.scrollTop - expected) > 1) return;
    container.scrollTop += align();
    expected = container.scrollTop;
    if (--left > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const GAP_LABEL_KEYS: Record<SearchGapPosition, "sessions.searchGapBefore" | "sessions.searchGap" | "sessions.searchGapAfter"> = {
  before: "sessions.searchGapBefore",
  middle: "sessions.searchGap",
  after: "sessions.searchGapAfter",
};

/**
 * 包住一块渲染好的正文：挂载、内容或关键词变化时重算这一块的命中范围并登记，
 * 卸载时注销。高亮接口不生效时就是一个普通的容器。
 *
 * 登记放在布局阶段（useLayoutEffect）：打开命中会话的当帧定位（见 MessageView
 * 里的 searchJump）要读到这些范围，得赶在那一帧绘制之前。
 */
function SearchHighlightArea({ blockKey, text, children }: { blockKey: string; text: string; children: React.ReactNode }) {
  const { registry, active, query, offsets, hitBlocks } = useContext(SearchHighlightContext);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    // 搜索词每变一次，所有已挂载的文字块都会走到这里；长会话里绝大多数块不含
    // 关键词——按计数用的同一份可见文字先筛一遍，不含的块不扫页面。
    if (!hitBlocks.has(blockKey)) {
      registry.removeBlock(blockKey);
      return;
    }
    registry.setBlock(blockKey, offsets.get(blockKey) ?? 0, findMatchRanges(el, query));
    return () => registry.removeBlock(blockKey);
  }, [active, query, offsets, hitBlocks, registry, blockKey, text]);
  return (
    <div ref={ref} className="overflow-hidden">
      {children}
    </div>
  );
}

interface MessageViewProps {
  messages: Message[];
  /** v0.8.1 需求7：会话 id——用户消息 pill 的 id→中文名映射按会话加载。 */
  sessionId?: string | null;
  initialSearchQuery?: string;
  searchQuery?: string;
  searchNavigation?: MessageSearchNavigation | null;
  onSearchStatusChange?: (status: MessageSearchStatus) => void;
  /**
   * v0.9.8 需求23：搜索跳转信号——打开一个在当前搜索词下有命中的会话时由页面
   * 发出（目标会话 + 递增序号，只在定位完成前存在）。视图在当帧把第一处命中
   * 放到视口正中，不等「上一处/下一处」那条 120ms 后平滑滚动的路。
   */
  searchJump?: SearchJump | null;
  /** 搜索跳转已完成（或本视图没有可定位的命中）——页面据此解除滚动遮蔽。 */
  onSearchJumpDone?: () => void;
  flat?: boolean;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** v0.9.4 性能优化：跳转扩窗信号（nonce 递增 → 渲染窗口扩至全量）——
   * turn-rail 跳转目标在窗口外时由父组件 bump 后下一帧定位。 */
  expandSignal?: number;
  /**
   * 可选角色解析器（三角色场景）。对 `user` 消息调用，返回非空 `MessageRoleView`
   * 时按解析结果渲染（如「任务助手」）。返回 `null` 走默认 `user` 渲染。
   * 默认 undefined 时完全不触发，保护常规会话（需求七）。
   */
  roleResolver?: (msg: Message) => MessageRoleView | null;
  /** v0.9.7 需求13：编辑最近用户消息——非空时最后一条用户消息显示编辑
   * 入口（复制旁）；提交回调 (rawText 落盘原文, newText 编辑后文本)，截断
   * 重发链由页面承担。null/undefined = 不可编辑（新会话/流式占位等）。 */
  onEditLastUserMessage?: ((rawText: string, newText: string, remainingToolIds?: string[]) => void) | null;
  /** v0.9.8 需求2：清除「未送达」消息（pending 幽灵——编辑重发失败/投递
   * 挂死后并入渲染的行）。仅 unsent 消息渲染删除入口；页面承担调
   * dismiss_pending_message 与本地列表移除。 */
  onDismissUnsent?: ((msg: Message) => void) | null;
}

/**
 * 三角色渲染视图描述（`MessageView` 的 `roleResolver` 返回值）。
 * 仅用于覆盖 `user` 消息的默认渲染（真人 vs 主进程派发）。
 */
export interface MessageRoleView {
  /** orchestrator = 主进程派发（任务助手）；其余走默认。 */
  role: "orchestrator" | "user" | "assistant";
  /** 气泡顶部标签，如「任务助手」。 */
  label: string;
  /** 对齐方向，默认 right（与 user 一致）。 */
  align?: "left" | "right";
  /** 色调：primary = 任务助手高亮底色；default = 普通 user。 */
  tone?: "primary" | "default";
}

export interface MessageSearchStatus {
  current: number;
  total: number;
}

export interface MessageSearchNavigation {
  direction: 1 | -1;
  nonce: number;
}

export type RenderItem =
  | { kind: "block"; block: ContentBlock; messageIndex: number; blockIndex: number }
  | { kind: "interaction"; items: InteractionCardItem[]; origin?: string; messageIndex: number; blockIndex: number }
  | { kind: "tool-group"; calls: ToolCall[] };

type RenderRow = SessionRowModel;

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
  // 懒渲染：折叠时不创建大段 thinking 文本节点（conductor 会话常有 8000+ token 思考块，
  // 常驻 DOM 会拖累挂载成本与内存）。展开后才渲染 <pre>。
  const [open, setOpen] = useState(false);

  return (
    <details
      className="rounded-[6px] border border-border/40 bg-[var(--message-thinking-bg)] px-2.5 py-1.5 text-xs text-muted-foreground"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none hover:text-foreground">
        {t("sessions.showThinking")}
      </summary>
      {open && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
          {block.thinking}
        </pre>
      )}
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
  // v0.9.8 需求23：文字高亮接口生效时正文照常渲染（表格、代码高亮都在），命中
  // 由外层 SearchHighlightArea 在渲染结果上上色；这里的 query 只用于回落方式
  //（接口不可用时把正文退回源码、按关键词切分加 <mark>）。
  // 只读「是否生效」这一项（单独的上下文，不随搜索词变化）——读带搜索词的那份，
  // 每换一次搜索词所有文字块都会重渲染。
  const highlightActive = useContext(SearchHighlightModeContext);
  const plainQuery = highlightActive ? "" : query;
  if (dark) {
    const display = stripImagePrompt(text);
    // v0.8.1 需求7（28f37e8e 形态）：用户文本块内联渲染（span 而非 div），
    // 使其可与插件 pill 在同一行内共处——pill 只是内联视觉元素，不占独立行。
    return (
      <span className="whitespace-pre-wrap break-all" style={{ fontSize: "var(--font-size-prose)" }}>
        {plainQuery ? highlightText(display, plainQuery, matchOffset ?? 0, currentMatch ?? -1) : display}
      </span>
    );
  }

  if (plainQuery.trim()) {
    return (
      <div className="markdown-prose overflow-hidden whitespace-pre-wrap break-words text-sm">
        {highlightText(text, plainQuery, matchOffset ?? 0, currentMatch ?? -1)}
      </div>
    );
  }

  // v0.9.8 需求5（合并版）：推荐块分段渲染——文本段走既有 markdown，
  // 推荐段渲染 EquipRecommendCard（搜索态上方已提前返回，不受影响）。
  // 限次硬闸补丁：同一条消息内只有**首个**推荐块渲染成卡（卡自身的
  // count 检查是异步的，同屏并发 mount 会双双通过——同消息多块在此处
  // 同步拦死；跨消息的块因时间差由卡的 count 检查兜住）。
  const segments = extractEquipSegments(text);
  if (segments.some((s) => s.type === "recommend")) {
    let recommendSeen = false;
    return (
      <div className="markdown-prose overflow-hidden">
        {segments.map((seg, i) => {
          if (seg.type === "text") {
            return seg.content.trim() ? (
              <ReactMarkdown
                key={i}
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                urlTransform={jishuUrlTransform}
                components={MARKDOWN_COMPONENTS}
              >
                {seg.content}
              </ReactMarkdown>
            ) : null;
          }
          if (recommendSeen) {
            return <div key={i} className="my-1 text-xs text-muted-foreground">·</div>;
          }
          recommendSeen = true;
          return <EquipRecommendCard key={i} payload={seg.payload} />;
        })}
      </div>
    );
  }

  return (
    <div className="markdown-prose overflow-hidden">
      {/* v0.9.2 需求1 M4：块渲染器咨询点——已启用插件（HTML/Mermaid 渲染等）
          声明的代码块增强渲染在此接管；未命中回退默认 markdown 代码块。 */}
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={jishuUrlTransform}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** pre 覆写：提取子 code 的语言与文本，咨询块渲染器（Context 注入）。
 * v0.9.3 测试期修复：取数改经 extractCodeText 递归提取——rehype-highlight
 * 会把 html 等已识别语言拆成 hljs span 节点，原先只收集纯字符串子节点，
 * 取出残缺文本导致 HTML 块恒不渲染（mermaid 非 hljs 语言不受影响）。 */
function MarkdownPreWithRenderers({ children }: { children?: React.ReactNode }) {
  const renderers = useBlockRenderers();
  const child = Array.isArray(children) ? children[0] : children;
  const codeProps =
    child && typeof child === "object" && "props" in child
      ? (child as { props?: { className?: string; children?: unknown } }).props
      : undefined;
  const language = /language-([\w-]+)/.exec(codeProps?.className ?? "")?.[1] ?? "";
  const code = extractCodeText(codeProps?.children as React.ReactNode);
  const renderer = renderers.length > 0 && language && code ? matchBlockRenderer(renderers, language, code) : null;
  // 需求14：遮蔽命中观测——哪个插件接管了哪个语言的代码块。
  // 日志在提交之后写：渲染期间写日志会同步刷新日志面板，把正在进行的低优先级渲染
  // （如搜索词延迟生效）打断重来——v0.9.8 需求23 实测逐帧空转、搜索永远不生效。
  const pluginId = renderer ? (renderer as { pluginId?: string }).pluginId : undefined;
  const hitLanguage = language.toLowerCase();
  useEffect(() => {
    if (!renderer) return;
    devLog("capability", `block-renderer hit: ${hitLanguage} → ${pluginId ?? "unknown"}`, {
      language: hitLanguage,
      pluginId,
    });
  });
  if (renderer) {
    const Renderer = renderer.Component;
    // 需求14 M1（K5）：接管可见性——右上角轻角标（hover 提亮，title 全称），
    // 「谁接管了这块」一眼可辨（含遮蔽内置的场合）。
    if (pluginId) {
      const source = renderer as { pluginId?: string; pluginLabel?: string };
      return (
        <div className="relative">
          <span
            className="pointer-events-none absolute -top-0.5 right-1 z-10 rounded bg-background/70 px-1 text-[9px] leading-4 text-muted-foreground/50"
            title={`由插件渲染：${source.pluginLabel ?? source.pluginId}（${source.pluginId}）`}
          >
            ⚙ {source.pluginLabel ?? source.pluginId}
          </span>
          <Renderer code={code} language={language} />
        </div>
      );
    }
    return <Renderer code={code} language={language} />;
  }
  return <pre>{children}</pre>;
}

/** Markdown 的组件映射是固定值——每次渲染新建对象会让 Markdown 组件白白重渲染。 */
const MARKDOWN_COMPONENTS = { pre: MarkdownPreWithRenderers, a: ArtifactLink };

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

/**
 * v0.9.5 需求5 T3 排查：单块渲染点。日志在提交之后写：渲染期间写日志会同步
 * 刷新日志面板，把正在进行的低优先级渲染（如搜索词延迟生效）打断重来。
 */
function LoggedInteractionBlock({ block }: { block: Extract<ContentBlock, { type: "interaction" }> }) {
  useEffect(() => {
    devLog("session", "ia-render:block", { prompt: block.prompt.slice(0, 24) });
  }, [block]);
  return <InteractionBlockWithRenderers items={[interactionBlockToItem(block)]} origin={block.origin} />;
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
      return <LoggedInteractionBlock block={block} />;
    case "phase_divider":
      return <PhaseDividerBlockWithRenderers phase={block.phase} title={block.title} />;
    default:
      return null;
  }
}

/** v0.9.3 需求2（P1-2）：interaction 块行级咨询点——渲染前咨询已启用插件
 *  的 blockTypes 扩展接管（matchBlockTypeRenderer），未命中回退内置
 *  InteractionCard。三个渲染点（renderBlock / 助手气泡分组项 / 用户侧气泡
 *  分组项）统一经本组件，插件页开关自此真实生效。 */
/** v0.9.3 需求10 B1：phase_divider 行级咨询点——渲染前咨询已启用插件的
 * blockTypes 扩展接管（matchBlockTypeRenderer），未命中回退内置
 * PhaseDivider（插件页开关真实生效；interaction 同款机制）。 */
function PhaseDividerBlockWithRenderers({ phase, title }: { phase: string; title: string }) {
  const renderers = useBlockRenderers();
  const renderer = matchBlockTypeRenderer(renderers, "phase_divider");
  if (renderer) {
    const Block = renderer.BlockComponent;
    return <Block block={{ type: "phase_divider", text: phase, title }} />;
  }
  return <PhaseDivider phase={phase} title={title} />;
}

function InteractionBlockWithRenderers({ items, origin }: { items: InteractionCardItem[]; origin?: string }) {
  // v0.9.4 需求11（修正版）：共享咨询渲染链（插件优先保留，回退内置默认
  // 展开保留选项）——与流式侧同一组件，两侧一致。
  return <InteractionBlock items={items} origin={origin} defaultOpen />;
}

// buildRenderRows/isUserToolResultOnlyMessage 已迁移至
// @/features/session-kernel/view-model（buildSessionRows）。

const isInteractionTool = (name: string, input: any) => {
  return isInteractionToolName(name) || looksLikeInteractionToolInput(input);
};

function interactionBlockToItem(block: Extract<ContentBlock, { type: "interaction" }>): InteractionCardItem {
  return {
    prompt: block.prompt,
    options: block.options,
    answer: block.answer,
    selectedOptions: block.selected_options,
  };
}

function buildRenderItemsForMessages(
  messages: Message[],
  messageIndices: number[],
  resultMap: Map<string, { output: string; details?: Record<string, unknown> }>,
  errorToolIds: Set<string>,
): RenderItem[] {
  const items: RenderItem[] = [];
  let pendingTools: ToolCall[] = [];
  const hasPersistedInteraction = messageIndices.some((messageIndex) =>
    messages[messageIndex].content.some((block) => block.type === "interaction"),
  );

  // v0.9.8 需求9-①→D9-4 紧档：失败卡之后**第一张同名调用** success 才翻
  //「已重试成功」（宽档「任意后续同名成功即翻」废弃——bash 类通用工具
  // 换了目的跑成功不再洗白前面的失败；失败→失败都不翻，错误输出保留
  // 可展开）。直播侧（use-stream-store）与回放共用 computeRetriedSuccessFlags
  // ——两侧口径单一实现。
  const orderedCalls: Array<{ id: string; name: string; isError: boolean }> = [];
  for (const messageIndex of messageIndices) {
    for (const block of messages[messageIndex].content) {
      if (block.type === "tool_use") {
        orderedCalls.push({ id: block.id, name: block.name, isError: errorToolIds.has(block.id) });
      }
    }
  }
  const retriedToolIds = computeRetriedSuccessFlags(orderedCalls);

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
          const rawAnswer = resultMap.get(block.id)?.output ?? "";

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
            kind: "interaction",
            items: [{
              prompt: rawPrompt,
              options: parsedOptions,
              answer: rawAnswer,
            }],
            origin,
            messageIndex,
            blockIndex,
          });
          return;
        }

        const id = block.id || `${block.name}-${messageIndex}-${blockIndex}`;
        const retried = retriedToolIds.has(id);
        pendingTools.push({
          id,
          toolName: block.name,
          kind: resolveToolKind(block.name, block.view),
          view: block.view,
          // 回放状态与直播对齐：tool_result 带 is_error 的失败调用显示
          // Error 徽标（此前硬编码 success，把真实失败掩成 Done）；
          // 存在后置同名成功结果的按「已重试成功」呈现（需求9-①）。
          status: retried ? "success" : errorToolIds.has(block.id) ? "error" : "success",
          retriedSuccess: retried || undefined,
          input: typeof block.input === "object" && block.input !== null
            ? (block.input as Record<string, unknown>)
            : {},
          output: resultMap.get(block.id)?.output,
          // 需求4 F3：回放路 details 透传（payload 契约见 API.md 挂载节）。
          details: resultMap.get(block.id)?.details,
        });
        return;
      }

      if (block.type === "tool_result") return;

      if (block.type === "interaction") {
        flushTools();
        items.push({
          kind: "interaction",
          items: [interactionBlockToItem(block)],
          origin: block.origin,
          messageIndex,
          blockIndex,
        });
        return;
      }

      flushTools();
      items.push({ kind: "block", block, messageIndex, blockIndex });
    });
  }

  flushTools();

  // Group consecutive interaction blocks in the same message segment
  const groupedItems: RenderItem[] = [];
  for (const item of items) {
    if (item.kind === "interaction") {
      const last = groupedItems[groupedItems.length - 1];
      if (last && last.kind === "interaction") {
        last.items.push(...item.items);
        last.origin = last.origin ?? item.origin;
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

function AssistantBubbleImpl({
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
  // v0.9.5 需求5 T3 排查：assistant 组渲染点（带间距修复的分支）。
  // 日志在提交之后写：渲染期间写日志会同步刷新日志面板，把正在进行的低优先级渲染
  // （如搜索词延迟生效）打断重来——v0.9.8 需求23 实测逐帧空转、搜索永远不生效。
  useEffect(() => {
    for (const item of items) {
      if (item.kind === "interaction") {
        devLog("session", "ia-render:assistant-group", { items: item.items.length, blockIndex: item.blockIndex });
      }
    }
  }, [items]);

  // v0.9.5 需求4 P2：三段式重组（工作项折叠 + 正文 + 文件概览）。
  const segments = buildTurnSegments(items);
  const renderItems = (list: RenderItem[]) =>
      list.map((item, idx) => {
        if (item.kind === "tool-group") {
          return (
            <div key={`tg-${idx}`} className="rounded-[8px]">
              <ToolGroup calls={item.calls} />
            </div>
          );
        }

        if (item.kind === "interaction") {
          return (
            <div
              key={`interaction-${item.messageIndex}-${item.blockIndex}`}
              className="overflow-hidden [&:not(:first-child)]:mt-3"
            >
              <InteractionBlockWithRenderers items={item.items} origin={item.origin} />
            </div>
          );
        }

        const offsetKey = `${item.messageIndex}-${item.blockIndex}`;
        const rendered = renderBlock(
          item.block,
          renderingQuery,
          false,
          searchOffsets.get(offsetKey) ?? 0,
          currentOcc,
        );
        // v0.9.8 需求23：文字块包进 SearchHighlightArea——命中在渲染结果上上色；
        // 思考块、问答卡、阶段分隔线不参与搜索，保持普通容器。
        if (item.block.type === "text") {
          return (
            <SearchHighlightArea
              key={`b-${item.messageIndex}-${item.blockIndex}`}
              blockKey={offsetKey}
              text={item.block.text}
            >
              {rendered}
            </SearchHighlightArea>
          );
        }
        return (
          <div key={`b-${item.messageIndex}-${item.blockIndex}`} className="overflow-hidden">
            {rendered}
          </div>
        );
      });

  return (
    <div className="w-full">
      <div className="max-w-full min-w-0 flex flex-col">
        <div className="flex items-center gap-2 mb-0.5 text-[11px]">
          <span className="font-medium text-muted-foreground">{t("sessions.assistant")}</span>
        </div>
        {/* v0.9.5 需求4 P2：三段式——已工作折叠 + 正文 + 文件改动概览。 */}
        <div className="min-w-0 max-w-full rounded-xl px-3 py-2 bg-[var(--message-assistant-bg)] text-[var(--message-assistant-fg)]">
          <TurnGroupView
            segments={segments}
            renderTextItems={renderItems}
            renderWorkItems={renderItems}
          />
        </div>
        <div className="self-start">
          <CopyButton text={copyText} />
        </div>
      </div>
    </div>
  );
}


function UserBubbleImpl({
  msg,
  items,
  renderingQuery,
  searchOffsets,
  currentOcc,
  messageIndex,
  roleView,
  toolNames,
  toolCats,
  onEditSubmit,
  onDismissUnsent,
}: {
  msg: Message;
  items: RenderItem[];
  renderingQuery: string;
  searchOffsets: Map<string, number>;
  currentOcc: number;
  messageIndex: number;
  roleView?: MessageRoleView | null;
  toolNames: Record<string, string>;
  /** 需求7 补充：id→category（pill 图标按类型）。 */
  toolCats?: Record<string, string>;
  /** 需求13：非空=本气泡是可编辑的最近用户消息（提交回调收编辑后文本+
   * 保留的工具调用 id——编辑可删/留工具）。 */
  onEditSubmit?: ((newText: string, remainingToolIds?: string[]) => void) | null;
  /** v0.9.8 需求2：非空=本气泡是未送达消息（pending 幽灵），显示删除入口。 */
  onDismissUnsent?: (() => void) | null;
}) {
  const { t } = useTranslation();
  // v0.9.5 需求5 T3 排查：user 组渲染点（带间距修复的分支）。
  // 日志在提交之后写：渲染期间写日志会同步刷新日志面板，把正在进行的低优先级渲染
  // （如搜索词延迟生效）打断重来——v0.9.8 需求23 实测逐帧空转、搜索永远不生效。
  useEffect(() => {
    for (const item of items) {
      if (item.kind === "interaction") {
        devLog("session", "ia-render:user-group", { items: item.items.length, blockIndex: item.blockIndex });
      }
    }
  }, [items]);
  // 需求13：原位编辑态（zcode 式——气泡内容替换为编辑框，Enter 确认/Esc 取消）。
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // 需求13 样式反馈（2026-11-11 用户实测「编辑框变窄」）：textarea 固有默认
  // 宽（~20 字符）会把自适应气泡撑窄——进入编辑时记录气泡原宽，编辑态容器
  // 钉住原宽（min 260 保短消息可编辑），编辑框透明无边框继承气泡文字样式
  //（「原样气泡变成可编辑」）。
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [editWidth, setEditWidth] = useState<number | null>(null);
  // 收版反馈（2026-11-13 用户裁决「编辑的时候能编辑工具」）：编辑态工具
  // pill 可删可留——重发只带保留的工具调用。
  const [draftToolIds, setDraftToolIds] = useState<string[]>([]);
  // v0.9.0 需求3 方案 C：pill 数据源为首文本块的 tool_ids 元数据（回放由
  // 后端 extract_tool_snapshot 从注入块派生）；文本标记解析已废弃。
  const firstTextBlock = msg.content.find((b) => b.type === "text");
  const rawText = firstTextBlock && firstTextBlock.type === "text" ? firstTextBlock.text : "";
  // 需求2 收版反馈 H：剥内部命令前缀——任务首条经 prepareTaskLaunchMessage
  // 包装为 `/jishu-task dev <goal>` 落盘，回放气泡显示/复制均应还原用户原话
  //（内部路由指令不属于用户可见内容）。
  const displayText = rawText.replace(/^\/jishu-task(?:\s+(?:dev|research))?\s+/, "");
  const toolIds = (firstTextBlock && firstTextBlock.type === "text" ? firstTextBlock.tool_ids : undefined) ?? [];
  const copyText = extractMessageText(msg).replace(/^\/jishu-task(?:\s+(?:dev|research))?\s+/, "");

  // 三角色：roleResolver 解析为 orchestrator（主进程派发）→ 「任务助手」样式。
  const isOrchestrator = roleView?.role === "orchestrator";
  const label = isOrchestrator ? roleView!.label : t("sessions.user");

  return (
    <div className="w-full flex justify-end">
      <div className="max-w-[88%] min-w-0 flex flex-col items-end">
        <div className="flex items-center gap-2 mb-0.5 text-[11px]">
          {isOrchestrator && <Bot className="h-3 w-3 text-primary" />}
          <span className={cn("font-medium", isOrchestrator ? "text-primary" : "text-muted-foreground")}>
            {label}
          </span>
          {onDismissUnsent && (
            // v0.9.8 需求2：pending 未落盘并入的「未送达」标识——客观描述
            // 功能状态，不交代过程。
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-600 dark:text-amber-400">
              {t("sessions.unsentBadge", "未送达")}
            </span>
          )}
        </div>
        <div
          ref={bubbleRef}
          style={editing && editWidth ? { width: Math.max(editWidth, 260) } : undefined}
          className={cn(
            "min-w-0 max-w-full space-y-1.5 rounded-xl px-3 py-2",
            isOrchestrator
              ? "bg-primary/10 text-foreground"
              : "bg-[var(--message-user-bg)] text-[var(--message-user-fg)]",
          )}
        >
          {editing ? (
            // 需求13：原位编辑（zcode 式）——textarea 预填原话，Enter 提交
            //（Shift+Enter 换行）、Esc 取消；按钮同排兜底。
            <div className="flex flex-col gap-2" onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                // 需求9 甲：pill 列表空（文本含字样形态）→ 从文本重扫 ids。
                if (draft.trim()) { setEditing(false); onEditSubmit?.(draft.trim(), draftToolIds.length > 0 ? draftToolIds : scanToolIdsFromText(draft.trim(), toolNames)); }
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}>
              {draftToolIds.length > 0 && (
                <EmbeddedToolPills
                  toolIds={draftToolIds}
                  toolNames={toolNames}
                  toolCats={toolCats}
                  onRemove={(id) => setDraftToolIds((prev) => prev.filter((x) => x !== id))}
                />
              )}
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(10, Math.max(2, draft.split("\n").length + 1))}
                className="w-full resize-none rounded-md bg-transparent px-1 py-0.5 font-[inherit] text-[inherit] leading-normal outline-none focus:ring-1 focus:ring-primary/60"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
                >
                  {t("common.cancel", "取消")}
                </button>
                <button
                  type="button"
                  disabled={!draft.trim()}
                  onClick={() => { const text = draft.trim(); setEditing(false); if (text) onEditSubmit?.(text, draftToolIds.length > 0 ? draftToolIds : scanToolIdsFromText(text, toolNames)); }}
                  className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground disabled:opacity-40"
                >
                  {t("sessions.editResend", "重发")}
                </button>
              </div>
            </div>
          ) : (
          <>
          <InlineImages text={displayText || copyText} />
          {items.map((item, idx) => {
            if (item.kind === "tool-group") {
              return <ToolGroup key={`tg-${idx}`} calls={item.calls} />;
            }

            if (item.kind === "interaction") {
              return (
                <div
                  key={`interaction-${item.messageIndex}-${item.blockIndex}`}
                  className="overflow-hidden [&:not(:first-child)]:mt-3"
                >
                  <InteractionBlockWithRenderers items={item.items} origin={item.origin} />
                </div>
              );
            }

            const offsetKey = `${messageIndex}-${item.blockIndex}`;
            // v0.8.1 需求7（28f37e8e 形态）：首文本块与插件 pill 同一个内联
            // 容器——pill 与正文同行流式排列；文本用 displayText（标记已剥，
            // 不再显示 [JISHU-TOOLS:...] 原文）。
            // v0.9.8 需求9-②（方案 B 统一末尾）：pill 渲染在正文之后——注入
            // 本就是后缀追加，原「pill 恒前置」误导（用户实测 #3）；与
            // UserTextWithPills（暂存/steer 路径）同序，展示面单源。
            if (item.block.type === "text" && item.block === firstTextBlock) {
              // v0.9.8 需求9 路线甲：正文含可内联 @[名] 字样（新消息——用户
              // 填入位置随文本持久）→ UserTextWithPills 就地内联（trailing
              // 排重内置）；无字样（历史剥离消息）→ 原 TextBlock+尾随路径。
              // v0.9.8 需求23：两条路径都包进 SearchHighlightArea——命中在渲染
              // 结果上上色，含字样路径同样参与（回落到源码切分时含字样路径仍
              // 不参与，属已知取舍）。
              if (hasKnownToolToken(displayText, toolNames)) {
                return (
                  <SearchHighlightArea key={`b-${item.blockIndex}`} blockKey={offsetKey} text={displayText}>
                    <UserTextWithPills text={displayText} toolIds={toolIds} toolNames={toolNames} toolCats={toolCats} />
                  </SearchHighlightArea>
                );
              }
              return (
                <Fragment key={`b-${item.blockIndex}`}>
                  <SearchHighlightArea blockKey={offsetKey} text={displayText}>
                    <TextBlock
                      text={displayText}
                      query={renderingQuery}
                      dark
                      matchOffset={searchOffsets.get(offsetKey) ?? 0}
                      currentMatch={currentOcc}
                    />
                  </SearchHighlightArea>
                  {toolIds.length > 0 && (
                    <EmbeddedToolPills toolIds={toolIds} toolNames={toolNames} toolCats={toolCats} trailing />
                  )}
                </Fragment>
              );
            }
            const rendered = renderBlock(
              item.block,
              renderingQuery,
              true,
              searchOffsets.get(offsetKey) ?? 0,
              currentOcc,
            );
            if (item.block.type === "text") {
              return (
                <SearchHighlightArea key={`b-${item.blockIndex}`} blockKey={offsetKey} text={item.block.text}>
                  {rendered}
                </SearchHighlightArea>
              );
            }
            return (
              <div key={`b-${item.blockIndex}`} className="overflow-hidden">
                {rendered}
              </div>
            );
          })}
          </>
          )}
        </div>
        <div className="self-end">
          <CopyButton text={copyText} />
          {onDismissUnsent && (
            // v0.9.8 需求2：未送达消息的清除入口（复制旁）。
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDismissUnsent();
              }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 mt-0.5 text-[11px] text-muted-foreground hover:text-destructive hover:bg-muted transition-colors"
              title={t("sessions.unsentDismiss", "删除这条未送达消息")}
            >
              <Trash2 className="h-3 w-3" />
              {t("sessions.unsentDelete", "删除")}
            </button>
          )}
          {onEditSubmit && !editing && (
            // 需求13：编辑最近用户消息（复制旁入口）。
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (bubbleRef.current) setEditWidth(bubbleRef.current.offsetWidth);
                setDraft(displayText || copyText);
                // 需求9 甲：文本含 @[名] 字样（新消息）→ pill 列表不置
                //（字样即载体，用户可在文中挪位置/删改；提交时重扫）。
                setDraftToolIds(hasKnownToolToken(displayText || copyText, toolNames) ? [] : toolIds);
                setEditing(true);
              }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 mt-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title={t("sessions.editLastMessage", "编辑并重发")}
            >
              <Pencil className="h-3 w-3" />
              {t("sessions.edit", "编辑")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// v0.9.8 需求23：气泡按属性跳过重渲染——搜索词变化时，渲染结果不依赖搜索词的行不再
// 重渲染（Markdown 不重新解析）。此前两个气泡每次父级重渲染都整体重渲染。
const AssistantBubble = memo(AssistantBubbleImpl);
AssistantBubble.displayName = "AssistantBubble";
const UserBubble = memo(UserBubbleImpl);
UserBubble.displayName = "UserBubble";

export const MessageView = memo(function MessageView({
  messages,
  sessionId,
  initialSearchQuery,
  searchQuery: externalSearchQuery,
  searchNavigation,
  onSearchStatusChange,
  searchJump,
  onSearchJumpDone,
  flat,
  scrollContainerRef,
  roleResolver,
  expandSignal,
  onEditLastUserMessage,
  onDismissUnsent,
}: MessageViewProps) {
  const { t } = useTranslation();
  // v0.8.1 需求7：用户消息 pill 的 id→中文名映射（按会话加载一次）。
  const toolNames = useSessionToolNames(sessionId ?? null);
  // 需求7 补充：pill 图标按类型（UserBubble 消费，+ 菜单同款映射）。
  const toolCats = useSessionToolCats(sessionId ?? null);
  const [localSearchQuery, setLocalSearchQuery] = useState(initialSearchQuery || "");
  const searchQuery = externalSearchQuery ?? localSearchQuery;
  const renderingQuery = useDeferredValue(searchQuery);
  const lastNavigationNonceRef = useRef(searchNavigation?.nonce ?? null);

  useEffect(() => {
    if (externalSearchQuery === undefined) {
      setLocalSearchQuery(initialSearchQuery || "");
    }
  }, [externalSearchQuery, initialSearchQuery]);

  // v0.9.8 需求23：搜索文本 = 用户看得见的文字（用户消息剥掉内部注入块，助手
  // 消息去掉 Markdown 语法符号），与侧栏搜索、气泡显示同一出处。
  const searchState = useMemo(() => {
    if (!renderingQuery.trim()) {
      return { total: 0, offsets: new Map<string, number>(), hitBlocks: new Set<string>(), matchToMessage: [] as number[] };
    }
    const regex = searchRegExp(renderingQuery);
    const offsets = new Map<string, number>();
    const hitBlocks = new Set<string>();
    const matchToMessage: number[] = [];
    let total = 0;

    messages.forEach((msg, mi) => {
      msg.content.forEach((block, bi) => {
        if (block.type !== "text") return;
        const key = `${mi}-${bi}`;
        offsets.set(key, total);
        const count = countMatches(blockSearchText(block, msg.role), regex);
        if (count > 0) hitBlocks.add(key);
        for (let i = 0; i < count; i++) matchToMessage.push(mi);
        total += count;
      });
    });

    return { total, offsets, hitBlocks, matchToMessage };
  }, [messages, renderingQuery]);

  // v0.9.8 需求23：渲染后标黄（命中范围登记处）+ 搜索态只显示命中消息。
  const isSearching = renderingQuery.trim().length > 0;
  // 需求23 补充轮：搜索词已经清空、列表还没展开的那一帧（延迟生效的搜索词慢一拍）不再记
  //「视口顶上是哪条行」——这时页面上可能已经是另一个会话（「进入会话」同时切会话、退出搜索），
  // 记下的行对新会话没有意义。
  const lensHolds = isSearching && searchQuery.trim().length > 0;
  const highlightRegistry = useMemo(() => new SearchHighlightRegistry(), []);
  const highlightActive = useMemo(() => isSearching && supportsTextHighlight(), [isSearching]);
  const hitMessages = useMemo(() => {
    const hits = new Set<number>();
    for (const messageIndex of searchState.matchToMessage) hits.add(messageIndex);
    return hits;
  }, [searchState]);

  const resultMap = useMemo(() => {
    const map = new Map<string, { output: string; details?: Record<string, unknown> }>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        // 需求4 F3：details 随结果透传（回放路；直播路在 use-stream-store）。
        const details =
          (block as { details?: Record<string, unknown> }).details &&
          typeof (block as { details?: Record<string, unknown> }).details === "object"
            ? (block as { details?: Record<string, unknown> }).details
            : undefined;
        map.set(block.tool_use_id, { output: content, details });
      }
    }
    return map;
  }, [messages]);

  const errorToolIds = useMemo(() => {
    const ids = new Set<string>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id && block.is_error) {
          ids.add(block.tool_use_id);
        }
      }
    }
    return ids;
  }, [messages]);

  const rows = useMemo<RenderRow[]>(() => buildSessionRows(messages), [messages]);
  // v0.9.4 需求7 测试期性能优化（用户实测：长会话来回切换卡顿）：渲染窗口
  // 化——默认只渲染最近 WINDOW 行（消息构建含 ReactMarkdown 全量解析与
  // 代码高亮，数百条全量渲染是切换卡顿主因），顶部「加载更早」扩窗。
  // 外部跳转信号（expandNonce）自动全窗；搜索态不走窗口，只显示命中行。
  const RENDER_WINDOW_ROWS = 120;
  const [windowRows, setWindowRows] = useState(RENDER_WINDOW_ROWS);
  useEffect(() => {
    setWindowRows(RENDER_WINDOW_ROWS);
  }, [sessionId]);
  // 外部跳转扩窗信号（turn-rail 目标在窗口外时父组件 bump）。
  const lastExpandSignalRef = useRef(expandSignal ?? 0);
  useEffect(() => {
    const signal = expandSignal ?? 0;
    if (lastExpandSignalRef.current === signal) return;
    lastExpandSignalRef.current = signal;
    setWindowRows(rows.length);
  }, [expandSignal, rows.length]);
  // 搜索态不再整窗渲染：只显示含命中的行（见 searchItems），渲染量与命中数
  // 成正比、与会话长度无关（v0.9.8 需求23）；窗口只管常态。
  const effectiveWindow = windowRows;
  const visibleRows = useMemo(
    () => (rows.length > effectiveWindow ? rows.slice(rows.length - effectiveWindow) : rows),
    [rows, effectiveWindow],
  );
  const hiddenCount = rows.length - visibleRows.length;
  const searchItems = useMemo<SearchDisplayItem<RenderRow>[]>(
    () => (isSearching ? buildSearchDisplayItems(rows, hitMessages) : []),
    [isSearching, rows, hitMessages],
  );
  const highlightContext = useMemo<SearchHighlightContextValue>(
    () => ({
      registry: highlightRegistry,
      active: highlightActive,
      query: renderingQuery,
      offsets: searchState.offsets,
      hitBlocks: searchState.hitBlocks,
    }),
    [highlightRegistry, highlightActive, renderingQuery, searchState.offsets, searchState.hitBlocks],
  );
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

  // 当前命中交给登记处上色（渲染后标黄）——文字块不必为「上一处 / 下一处」重渲染。
  useEffect(() => {
    highlightRegistry.setCurrent(isSearching ? currentOcc : -1);
  }, [highlightRegistry, currentOcc, isSearching]);

  // v0.9.8 需求23：打开一个在当前搜索词下有命中的会话——页面发来搜索跳转信号，
  // 当帧把第一处命中放到视口正中。不走下面那条「120ms 后平滑滚动」的导航：
  // 首帧就是最终位置，也不会和「打开会话滚到底」相争（搜索态下贴底跟随不启动）。
  const handledJumpRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!searchJump || searchJump.sessionId !== (sessionId ?? null) || searchJump.nonce === handledJumpRef.current) return;
    handledJumpRef.current = searchJump.nonce;
    if (isSearching && searchState.total > 0) {
      setCurrentOcc(0);
      const container = scrollContainerRef?.current;
      const list = listRef.current;
      const first = searchState.matchToMessage[0];
      const row = rows.find((r) => r.messageIndices.includes(first));
      const rowEl = list?.querySelector<HTMLElement>(`[data-message-index="${row?.messageIndices[0] ?? -1}"]`);
      const range = highlightActive ? highlightRegistry.getMatchRange(0) : undefined;
      // 量不到尺寸的位置不算（起止点已失效等）——退而按整行放，随后的导航再对正
      const sized = (rect: DOMRect | null | undefined) => (rect && (rect.width > 0 || rect.height > 0) ? rect : null);
      const matchRect = () =>
        sized(range ? rectOfMatch(range) : null) ??
        sized(list?.querySelector('[data-match-idx="0"]')?.getBoundingClientRect()) ??
        null;
      // 目标行按真实高度量（见 withRenderedRows）
      const target = rowEl
        ? withRenderedRows([rowEl], () => matchRect() ?? rowEl.getBoundingClientRect())
        : matchRect();
      if (container && target) centerInScroller(container, target);
    }
    onSearchJumpDone?.();
  }, [
    searchJump,
    sessionId,
    isSearching,
    searchState.total,
    searchState.matchToMessage,
    highlightActive,
    highlightRegistry,
    rows,
    scrollContainerRef,
    onSearchJumpDone,
  ]);

  // v0.9.8 需求23：搜索态只显示命中行，退出时上下的消息重新补进来。搜索期间记住
  // 「视口顶上是哪条行、离视口顶多远」（LensAnchor），列表展开后把它放回屏幕原处——
  // 正在看的内容不动。补偿在布局阶段完成（绘制之前），随后几帧只做微量修正。
  const lensAnchorRef = useRef<LensAnchor | null>(null);
  const pendingAnchorRef = useRef<LensAnchor | null>(null);
  const wasSearchingRef = useRef(false);
  const keepLensAnchor = useCallback(() => {
    const container = scrollContainerRef?.current;
    const list = listRef.current;
    if (!container || !list) return;
    const top = container.getBoundingClientRect().top;
    for (const row of list.querySelectorAll<HTMLElement>("[data-message-index]")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= top) continue; // 整行都在视口上方
      lensAnchorRef.current = { kind: "row", messageIndex: Number(row.dataset.messageIndex), offset: rect.top - top };
      return;
    }
    // 视口里没有消息行（停在列表最底，下面只剩「后面省略」细条）——记住「在底部」
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 2;
    lensAnchorRef.current = atBottom ? { kind: "bottom" } : null;
  }, [scrollContainerRef]);

  const putLensAnchorBack = useCallback(() => {
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;
    const container = scrollContainerRef?.current;
    const list = listRef.current;
    if (!container || !list) return;
    if (anchor.kind === "bottom") {
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      pendingAnchorRef.current = null;
      // 视口底部的行渲染后高度还会变——随后几帧跟着贴底
      holdScrollForFrames(container, () => container.scrollHeight - container.scrollTop - container.clientHeight);
      return;
    }
    const rowsInList = [...list.querySelectorAll<HTMLElement>("[data-message-index]")];
    const at = rowsInList.findIndex((el) => Number(el.dataset.messageIndex) === anchor.messageIndex);
    if (at < 0) {
      // 这一行在渲染窗口之外（长会话只渲染最近若干行）——扩窗把它渲染出来，
      // 渲染后（visibleRows 变化）由下面的 effect 接着放回
      const rowIndex = rows.findIndex((r) => r.messageIndices[0] === anchor.messageIndex);
      const needed = rowIndex < 0 ? 0 : rows.length - rowIndex;
      if (needed > windowRows) {
        setWindowRows(needed);
      } else {
        pendingAnchorRef.current = null; // 消息已不存在，或本该渲染却没渲染——不再等
      }
      return;
    }
    pendingAnchorRef.current = null;
    // 视口上方约一屏半以内的行，浏览器随后就会渲染、高度会变——连同目标行一起先按真实高度量
    const row = rowsInList[at];
    const reach = container.getBoundingClientRect().top - container.clientHeight * 1.5;
    const toRender = [row];
    for (let i = at - 1; i >= 0; i--) {
      if (rowsInList[i].getBoundingClientRect().bottom < reach) break;
      toRender.push(rowsInList[i]);
    }
    const offsetNow = () => row.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTop += withRenderedRows(toRender, () => offsetNow() - anchor.offset);
    // 更远的行若也被渲染、高度变了，随后几帧补回（用户一滚就停）
    holdScrollForFrames(container, () => offsetNow() - anchor.offset);
  }, [rows, windowRows, scrollContainerRef]);

  // 换了会话：上一条会话里记的行作废（新会话的行在同一次提交里重新记）。
  // 只在会话真的变了时清——首次挂载不清，否则会把这次提交刚记下的行抹掉。
  // 必须排在下面的「退出搜索」之前：「进入会话」（需求23 补充轮）会同时切会话、退出搜索，
  // 同一次提交里先作废旧会话的行，退出搜索才不会把它套到新会话上。
  const anchorSessionRef = useRef(sessionId);
  useLayoutEffect(() => {
    if (anchorSessionRef.current === sessionId) return;
    anchorSessionRef.current = sessionId;
    lensAnchorRef.current = null;
    pendingAnchorRef.current = null;
  }, [sessionId]);
  useLayoutEffect(() => {
    const exited = wasSearchingRef.current && !isSearching;
    wasSearchingRef.current = isSearching;
    if (!exited) return;
    pendingAnchorRef.current = lensAnchorRef.current;
    lensAnchorRef.current = null;
    putLensAnchorBack();
  }, [isSearching, putLensAnchorBack]);
  useLayoutEffect(() => {
    if (pendingAnchorRef.current) putLensAnchorBack();
  }, [visibleRows, putLensAnchorBack]);
  // 搜索期间每次提交后刷新（命中切换、内容更新都会改变「视口顶上是哪条行」）
  useLayoutEffect(() => {
    if (lensHolds) keepLensAnchor();
  });
  useEffect(() => {
    const container = scrollContainerRef?.current;
    if (!lensHolds || !container) return;
    container.addEventListener("scroll", keepLensAnchor, { passive: true });
    return () => container.removeEventListener("scroll", keepLensAnchor);
  }, [lensHolds, keepLensAnchor, scrollContainerRef]);

  useEffect(() => {
    if (searchState.total === 0 || scrollTrigger === 0) return;
    // If the target match is already rendered and fully inside the viewport,
    // just let the highlight move (driven by currentOcc) without scrolling —
    // avoids the jarring scroll-up-then-back jump when navigating between
    // matches that are already visible together on screen.
    const container = scrollContainerRef?.current;
    // 回落方式（源码切分）有 <mark> 元素；渲染后标黄只有登记的文字范围。
    const rowOfCurrent = () => {
      const msgIdx = searchState.matchToMessage[currentOcc];
      const row = rows.find((r) => r.messageIndices.includes(msgIdx));
      return row
        ? (listRef.current?.querySelector<HTMLElement>(`[data-message-index="${row.messageIndices[0]}"]`) ?? null)
        : null;
    };
    // 行在视口外、浏览器还没排版时范围量出来尺寸为 0——先让这一行按真实高度参与布局
    // 再量（见 withRenderedRows）。一行比屏幕还高时按「整行」滚等于没滚，长会话里
    // 几十处命中常常都在同一行，必须按命中自己的位置滚（v0.9.8 需求23 终验实测）。
    const rectOfCurrent = (): DOMRect | null => {
      const visibleEl = listRef.current?.querySelector(`[data-match-idx="${currentOcc}"]`);
      if (visibleEl) return visibleEl.getBoundingClientRect();
      const range = highlightActive ? highlightRegistry.getMatchRange(currentOcc) : undefined;
      if (!range) return null;
      const sized = (rect: DOMRect | null) => (rect && (rect.width > 0 || rect.height > 0) ? rect : null);
      const rowEl = rowOfCurrent();
      return sized(rectOfMatch(range)) ?? (rowEl ? withRenderedRows([rowEl], () => sized(rectOfMatch(range))) : null);
    };
    const shown = rectOfCurrent();
    if (container && shown) {
      const cr = container.getBoundingClientRect();
      if (shown.top >= cr.top && shown.bottom <= cr.bottom) return;
    }
    const msgIdx = searchState.matchToMessage[currentOcc];
    if (msgIdx === undefined) return;
    const timer = setTimeout(() => {
      const el = listRef.current?.querySelector(`[data-match-idx="${currentOcc}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const target = highlightActive ? rectOfCurrent() : null;
      if (container && target) {
        container.scrollTo({
          top: scrollTopToCenter({
            scrollTop: container.scrollTop,
            containerTop: container.getBoundingClientRect().top,
            containerHeight: container.clientHeight,
            targetTop: target.top,
            targetHeight: target.height,
          }),
          behavior: "smooth",
        });
        return;
      }
      rowOfCurrent()?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
    return () => clearTimeout(timer);
  }, [currentOcc, scrollTrigger, searchState.matchToMessage, searchState.total, highlightActive, highlightRegistry, rows, scrollContainerRef]);

  // 需求13：最后一条用户消息（尾向前）——唯一可编辑行；rawText 取首 text 块
  // 原文（落盘原文，含 /jishu-task 包装——页面回调按需重包装）。
  const lastUserMessageIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user") continue;
      // 工具结果型 user（插件/工具调用的回放形态）不是用户输入——排除
      //（与 buildSessionRows 行划分同口径；不排除时编辑入口会挂到工具
      // 结果上，真正可编辑的最后一条用户文字消息反而没有按钮）。
      if (isUserToolResultOnlyMessage(messages[i])) continue;
      return i;
    }
    return -1;
  }, [messages]);

  // v0.9.8 需求23：每行的 key、渲染条目、复制文本按消息缓存。搜索词每变一次
  // MessageView 都会重渲染，而 key 的计算要把整行消息文本拼出来（重行上百 KB），
  // 不能每次重算；条目的引用也要稳定，已显示的行才跳得过重渲染（Markdown 不重新解析）。
  const rowCache = useMemo(() => {
    const cache = new Map<RenderRow, { key: string; items: RenderItem[]; copyText: string }>();
    for (const row of rows) {
      cache.set(row, {
        key: rowKey(row, messages),
        items: buildRenderItemsForMessages(
          messages,
          row.kind === "assistant" ? row.messageIndices : [row.messageIndex],
          resultMap,
          errorToolIds,
        ),
        copyText: row.kind === "assistant" ? extractMessagesText(messages, row.messageIndices) : "",
      });
    }
    return cache;
  }, [rows, messages, resultMap, errorToolIds]);

  // 需求13：仅最后一条用户消息挂编辑提交（引用稳定——不随搜索词变化）。
  const editSubmit = useMemo(() => {
    if (!onEditLastUserMessage || lastUserMessageIndex < 0) return null;
    const msg = messages[lastUserMessageIndex];
    if (!msg) return null;
    return (newText: string, remainingToolIds?: string[]) => {
      const raw = msg.content.find((b) => b.type === "text");
      onEditLastUserMessage(raw && raw.type === "text" ? raw.text : "", newText, remainingToolIds);
    };
  }, [messages, onEditLastUserMessage, lastUserMessageIndex]);

  const renderRow = useCallback((row: RenderRow) => {
    const cached = rowCache.get(row);
    // 高亮接口生效时行的渲染结果不依赖搜索词——搜索属性给固定值（见 EMPTY_OFFSETS）
    const rowQuery = highlightActive ? "" : renderingQuery;
    const rowOffsets = highlightActive ? EMPTY_OFFSETS : searchState.offsets;
    const rowOcc = highlightActive ? NO_CURRENT_MATCH : currentOcc;
    if (row.kind === "assistant") {
      return (
        <AssistantBubble
          items={cached?.items ?? EMPTY_ITEMS}
          copyText={cached?.copyText ?? ""}
          renderingQuery={rowQuery}
          searchOffsets={rowOffsets}
          currentOcc={rowOcc}
        />
      );
    }

    const msg = messages[row.messageIndex];
    const roleView = roleResolver ? roleResolver(msg) : null;
    return (
      <UserBubble
        msg={msg}
        items={cached?.items ?? EMPTY_ITEMS}
        renderingQuery={rowQuery}
        searchOffsets={rowOffsets}
        currentOcc={rowOcc}
        messageIndex={row.messageIndex}
        roleView={roleView}
        toolNames={toolNames}
        toolCats={toolCats}
        onEditSubmit={row.messageIndex === lastUserMessageIndex ? editSubmit : null}
        onDismissUnsent={
          msg.unsent && onDismissUnsent ? () => onDismissUnsent(msg) : null
        }
      />
    );
  }, [rowCache, messages, highlightActive, renderingQuery, searchState.offsets, currentOcc, roleResolver, toolNames, toolCats, lastUserMessageIndex, editSubmit, onDismissUnsent]);

  const renderRowElement = (row: RenderRow) => (
    <div
      key={rowCache.get(row)?.key ?? rowKey(row, messages)}
      data-user-message={row.kind === "user" ? "true" : undefined}
      data-turn-index={row.kind === "user" ? row.turnIndex : undefined}
      data-message-index={row.messageIndices[0]}
      style={ROW_STYLE}
    >
      {renderRow(row)}
    </div>
  );

  // v0.9.1 需求5：user 行轮次序号（实例内从 0 递增），横杠导航轨按
  // [data-turn-index] 定位跳转。v0.9.2 需求1 P1：序号由统一视图模型携带
  // （buildSessionRows 计算，与轮次摘要消费方同源）。
  const fullMessageList = (
    <SearchHighlightModeContext.Provider value={highlightActive}>
    <SearchHighlightContext.Provider value={highlightContext}>
      <div className="relative">
        {/* v0.9.8 需求23：没有命中时消息照常显示，只在顶部浮一条提示——不挪动列表，
            停在会话底部的人不会因为列表塌掉被甩到顶部。提示吸顶：停在哪里都看得见。 */}
        {isSearching && searchState.total === 0 && (
          <div
            data-search-empty=""
            className="pointer-events-none sticky top-2 z-10 flex h-0 items-start justify-center"
          >
            <span className="rounded-full border border-border/60 bg-background/90 px-3 py-1 text-xs text-muted-foreground">
              {t("sessions.searchNoMatch", { query: renderingQuery })}
            </span>
          </div>
        )}
        <div ref={listRef} className="mx-auto w-full max-w-[var(--message-content-max-width)] space-y-2 px-4 py-3">
          {isSearching && searchState.total > 0 ? (
            // v0.9.8 需求23：搜索态只显示含命中的行，其余折成细条
            searchItems.map((item) =>
              item.kind === "gap" ? (
                <div
                  key={`gap-${item.before}`}
                  data-search-gap={item.count}
                  className="flex items-center gap-3 px-2 text-[11px] text-muted-foreground"
                >
                  <span className="h-px flex-1 bg-border/60" />
                  {t(GAP_LABEL_KEYS[item.position], { count: item.count })}
                  <span className="h-px flex-1 bg-border/60" />
                </div>
              ) : (
                renderRowElement(item.row)
              ),
            )
          ) : (
            <>
              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setWindowRows((n) => n + RENDER_WINDOW_ROWS * 2)}
                  className="mx-auto block rounded-full border border-border/60 bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                >
                  {t("sessions.loadEarlier", "加载更早的消息（剩余 {{count}} 行）", { count: hiddenCount })}
                </button>
              )}
              {visibleRows.map((row) => renderRowElement(row))}
            </>
          )}
        </div>
      </div>
    </SearchHighlightContext.Provider>
    </SearchHighlightModeContext.Provider>
  );

  if (flat) return <EquipSessionContext.Provider value={sessionId ?? null}>{fullMessageList}</EquipSessionContext.Provider>;

  return (
    <EquipSessionContext.Provider value={sessionId ?? null}>
      <div className="flex h-full flex-col">
        <ScrollArea className="flex-1 min-h-0 message-scroll" data-message-stream>
          {fullMessageList}
        </ScrollArea>
      </div>
    </EquipSessionContext.Provider>
  );
});
