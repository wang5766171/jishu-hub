/**
 * Shared conversation content rendering — used by regular chat (MessageView),
 * task planning overlay, and task conversation panel.
 *
 * Extracted from message-view.tsx so both regular sessions and task sessions
 * render agent output with the same markdown / thinking / code-block quality.
 */
import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useTranslation } from "react-i18next";
import type { ContentBlock } from "@/types";
import { InteractionCard } from "./interaction-card";
import type { InteractionCardItem } from "./interaction-card";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

/** Render a markdown text string with GFM + syntax highlighting. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown-prose overflow-hidden">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** Collapsible thinking block. */
export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
}: {
  thinking: string;
}) {
  const { t } = useTranslation();
  // 懒渲染：折叠时不创建大段 thinking 文本节点，降 DOM/内存（同 message-view.tsx）。
  const [open, setOpen] = useState(false);
  return (
    <details
      className="mt-2 rounded-[6px] border border-border/40 bg-[var(--message-thinking-bg)] px-2.5 py-1.5 text-xs text-muted-foreground"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none hover:text-foreground">
        {t("sessions.showThinking")}
      </summary>
      {open && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
          {thinking}
        </pre>
      )}
    </details>
  );
});

/** Render a single ContentBlock (text → markdown, thinking → collapsible, interaction → card). */
export function renderContentBlock(block: ContentBlock): React.ReactNode {
  switch (block.type) {
    case "text":
      return <MarkdownText text={block.text} />;
    case "thinking":
      return <ThinkingBlock thinking={block.thinking} />;
    case "interaction":
      return (
        <InteractionCard
          items={[{
            prompt: block.prompt,
            options: block.options,
            answer: block.answer,
            selectedOptions: block.selected_options,
          }]}
          origin={block.origin}
        />
      );
    case "phase_divider":
      return <PhaseDivider phase={block.phase} title={block.title} />;
    default:
      return null;
  }
}

export function PhaseDivider({ phase, title }: { phase: string; title: string }) {
  const theme = (() => {
    // v0.7.2 需求 6：浅色主题下阶段分割线改灰白基调（bg/text/border/shadow 用 muted），
    // 仅保留 dot 的 phase 颜色做语义区分；暗色（dark:*）保持不变。
    switch (phase) {
      case "discuss":
        return {
          bg: "bg-muted/80 colorful:bg-indigo-50/80 dark:bg-indigo-950/40",
          text: "text-muted-foreground colorful:text-indigo-600 dark:text-indigo-400",
          border: "border-border colorful:border-indigo-200/60 dark:border-indigo-900/60",
          dot: "bg-indigo-500",
          shadow: "colorful:shadow-sm colorful:shadow-indigo-100/50 dark:shadow-none"
        };
      case "plan":
        return {
          bg: "bg-muted/80 colorful:bg-amber-50/80 dark:bg-amber-950/40",
          text: "text-muted-foreground colorful:text-amber-600 dark:text-amber-400",
          border: "border-border colorful:border-amber-200/60 dark:border-amber-900/60",
          dot: "bg-amber-500",
          shadow: "colorful:shadow-sm colorful:shadow-amber-100/50 dark:shadow-none"
        };
      case "execute":
        return {
          bg: "bg-muted/80 colorful:bg-emerald-50/80 dark:bg-emerald-950/40",
          text: "text-muted-foreground colorful:text-emerald-600 dark:text-emerald-400",
          border: "border-border colorful:border-emerald-200/60 dark:border-emerald-900/60",
          dot: "bg-emerald-500",
          shadow: "colorful:shadow-sm colorful:shadow-emerald-100/50 dark:shadow-none"
        };
      default:
        return {
          bg: "bg-muted/80",
          text: "text-muted-foreground",
          border: "border-border",
          dot: "bg-muted-foreground",
          shadow: ""
        };
    }
  })();

  return (
    <div className="flex items-center justify-center gap-4 py-6" data-phase={phase}>
      <div className="h-[2px] flex-1 bg-gradient-to-r from-transparent via-border/70 to-border/40" />
      <div className={`flex items-center gap-2 rounded-full border px-4 py-1.5 ${theme.bg} ${theme.border} ${theme.shadow} backdrop-blur-sm transition-all hover:scale-105 duration-200`}>
        <span className="relative flex h-2 w-2">
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${theme.dot}`} />
          <span className={`relative inline-flex rounded-full h-2 w-2 ${theme.dot}`} />
        </span>
        <span className={`text-[12px] font-semibold tracking-wider uppercase ${theme.text}`}>
          {title}
        </span>
      </div>
      <div className="h-[2px] flex-1 bg-gradient-to-l from-transparent via-border/70 to-border/40" />
    </div>
  );
}

/** Render an array of ContentBlock (a full message body). */
export function renderContentBlocks(blocks: ContentBlock[]): React.ReactNode {
  const renderedBlocks: React.ReactNode[] = [];
  let currentGroup: InteractionCardItem[] = [];
  let currentOrigin: string | undefined = undefined;

  const flushGroup = (key: number) => {
    if (currentGroup.length === 0) return;
    renderedBlocks.push(
      <div key={`interaction-group-${key}`}>
        <InteractionCard items={currentGroup} origin={currentOrigin} />
      </div>
    );
    currentGroup = [];
    currentOrigin = undefined;
  };

  blocks.forEach((block, idx) => {
    if (block.type === "interaction") {
      currentGroup.push({
        prompt: block.prompt,
        options: block.options,
        answer: block.answer,
        selectedOptions: block.selected_options,
      });
      if (block.origin) {
        currentOrigin = block.origin;
      }
    } else {
      flushGroup(idx);
      renderedBlocks.push(
        <div key={idx}>{renderContentBlock(block)}</div>
      );
    }
  });
  flushGroup(blocks.length);

  return <>{renderedBlocks}</>;
}
