/**
 * Shared conversation content rendering — used by regular chat (MessageView),
 * task planning overlay, and task conversation panel.
 *
 * Extracted from message-view.tsx so both regular sessions and task sessions
 * render agent output with the same markdown / thinking / code-block quality.
 */
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useTranslation } from "react-i18next";
import type { ContentBlock } from "@/types";

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
  return (
    <details className="mt-2 rounded-[6px] border border-border/40 bg-[var(--message-thinking-bg)] px-2.5 py-1.5 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none hover:text-foreground">
        {t("sessions.showThinking")}
      </summary>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
        {thinking}
      </pre>
    </details>
  );
});

/** Render a single ContentBlock (text → markdown, thinking → collapsible). */
export function renderContentBlock(block: ContentBlock): React.ReactNode {
  switch (block.type) {
    case "text":
      return <MarkdownText text={block.text} />;
    case "thinking":
      return <ThinkingBlock thinking={block.thinking} />;
    default:
      return null;
  }
}

/** Render an array of ContentBlock (a full message body). */
export function renderContentBlocks(blocks: ContentBlock[]): React.ReactNode {
  return blocks.map((block, i) => (
    <div key={i}>{renderContentBlock(block)}</div>
  ));
}
