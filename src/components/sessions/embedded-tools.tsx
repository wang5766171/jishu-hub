/**
 * v0.8.1 需求10：消息内嵌工具 pill 渲染——检测 [JISHU-TOOLS:id1,id2] 标记，
 * 剥离标记文本，返回工具 id 列表供渲染层显示 pill（workbuddy 形态）。
 */

import { useEffect, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { Blocks } from "lucide-react";

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

/** 会话工具条目（后端 session_tool_list，与 chat-input 的 SessionTool 同构）。 */
interface SessionTool {
  id: string;
  display_name: string;
}

/** id → 显示名 缓存（按会话 key）。pill 渲染层只读这个映射：
 * 显示用中文名，标记与后端通信仍用英文 id——属性处理能力的单一来源。 */
const toolNamesCache = new Map<string, Record<string, string>>();

/** 加载会话工具的 id→显示名映射（v0.8.1 需求7：消息气泡 pill 显示中文名，
 * 而非插件英文编码）。同一会话只拉取一次，模块级缓存跨组件共享。 */
export function useSessionToolNames(sessionId: string | null): Record<string, string> {
  const key = sessionId ?? "__new_session__";
  const [names, setNames] = useState<Record<string, string>>(() => toolNamesCache.get(key) ?? {});
  useEffect(() => {
    let cancelled = false;
    const cached = toolNamesCache.get(key);
    if (cached) {
      setNames(cached);
      return;
    }
    invokeCommand<SessionTool[]>("session_tool_list", { sessionId: key })
      .then((tools) => {
        const map: Record<string, string> = {};
        for (const t of tools) map[t.id] = t.display_name;
        toolNamesCache.set(key, map);
        if (!cancelled) setNames(map);
      })
      .catch(() => {
        if (!cancelled) setNames({});
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return names;
}

/** 消息气泡内的内联工具 pill 组（v0.8.1 28f37e8e 形态修正：**内联**渲染——
 * 与正文同一个 whitespace-pre-wrap 流，pill 与文本同行排列，不再用块级
 * div 强制换行。pill 是一个视觉整体，仅渲染，不做其他特殊处理）。 */
export function EmbeddedToolPills({
  toolIds,
  toolNames,
}: {
  toolIds: string[];
  toolNames: Record<string, string>;
}) {
  if (toolIds.length === 0) return null;
  return (
    <span className="mr-1 inline-flex flex-wrap items-center gap-1 align-baseline">
      {toolIds.map((id) => (
        <span
          key={id}
          className="inline-flex max-w-[10rem] items-center gap-1 rounded-md border border-border/70 bg-muted/70 px-1.5 py-0.5 align-baseline text-xs text-foreground"
          title={id}
        >
          <Blocks className="h-3 w-3 shrink-0 text-[var(--icon-config)]" />
          <span className="truncate">{toolNames[id] ?? id}</span>
        </span>
      ))}
    </span>
  );
}

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

/** 用户消息正文展示统一组件（M5）：剥 [JISHU-TOOLS] 标记 → pill + 正文
 * 同一内联流。四个用户消息展示面（回放/流式/引导占位/暂存）共用，杜绝
 * 新增面漏解析导致标记原文可见（§16.3 单源纪律）。 */
export function UserTextWithPills({
  text,
  toolNames,
}: {
  text: string;
  toolNames: Record<string, string>;
}) {
  const { text: display, toolIds } = parseEmbeddedTools(text);
  return (
    <span className="whitespace-pre-wrap break-all">
      <EmbeddedToolPills toolIds={toolIds} toolNames={toolNames} />
      {display}
    </span>
  );
}
