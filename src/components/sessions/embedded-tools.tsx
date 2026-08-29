/**
 * v0.8.1 需求10：消息内嵌工具 pill 渲染——检测 [JISHU-TOOLS:id1,id2] 标记，
 * 剥离标记文本，返回工具 id 列表供渲染层显示 pill（workbuddy 形态）。
 */

const TOOLS_MARKER_RE = /^\[JISHU-TOOLS:([^\]]+)\]\s?/;

export interface EmbeddedTools {
  /** 剥离标记后的纯文本 */
  text: string;
  /** 标记中的工具 id 列表 */
  toolIds: string[];
}

export function parseEmbeddedTools(text: string): EmbeddedTools {
  const match = text.match(TOOLS_MARKER_RE);
  if (!match) return { text, toolIds: [] };
  const toolIds = match[1]
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return { text: text.slice(match[0].length), toolIds };
}

/** 渲染内嵌工具 pill 组（用于消息气泡内，显示在文本上方）。 */
export function EmbeddedToolPills({
  toolIds,
  toolNames,
}: {
  toolIds: string[];
  toolNames: Record<string, string>;
}) {
  if (toolIds.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1">
      {toolIds.map((id) => (
        <span
          key={id}
          className="inline-flex max-w-[10rem] items-center gap-1 rounded-md border border-border/70 bg-muted/70 px-1.5 py-0.5 text-xs text-foreground"
          title={id}
        >
          <Blocks className="h-3 w-3 shrink-0 text-[var(--icon-config)]" />
          <span className="truncate">{toolNames[id] ?? id}</span>
        </span>
      ))}
    </div>
  );
}

import { Blocks } from "lucide-react";

/** 单个工具 pill（输入框 mirror 层用：视觉替换 `@[显示名]` token）。
 * 结构：透明等宽占位（与 textarea 里 token 文本同宽）+ 绝对定位的可见
 * pill——保证光标位置与视觉 pill 对齐。 */
export function EmbeddedToolPill({ name }: { name: string }) {
  return (
    <span className="relative inline-flex" data-tool-pill="">
      {/* 等宽占位：与 textarea 中的 `@[name]` 文本等宽（同字体继承） */}
      <span className="invisible whitespace-pre">@[{name}]</span>
      <span className="absolute inset-y-0 left-0 inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted px-1.5 text-xs leading-none text-foreground">
        <Blocks className="h-3 w-3 shrink-0 text-[var(--icon-config)]" />
        <span className="truncate">{name}</span>
      </span>
    </span>
  );
}
