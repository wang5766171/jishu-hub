/**
 * v0.9.0 需求3 方案 C：消息内嵌工具 pill 渲染——数据源为消息元数据
 * `tool_ids`（回放：后端从注入块派生；流式：compose 时前端已知并显式传递）。
 * 文本标记（[JISHU-TOOLS:...]）方案已按版本级裁决整体废弃，本模块不再
 * 做任何文本解析。
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { Blocks, X } from "lucide-react";
import { cn } from "@/lib/utils";

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
  onRemove,
  trailing,
}: {
  toolIds: string[];
  toolNames: Record<string, string>;
  /** 收版反馈（2026-11-13 用户裁决）：编辑态工具可删——传入后每个 pill 带
   * 移除按钮（删除本次重发不再携带该工具调用；不传=静态展示）。 */
  onRemove?: (id: string) => void;
  /** v0.9.8 需求9-②：pill 位于正文之后时置 true——外距换向前（mr→ml），
   * 与前置排版的间距镜像。 */
  trailing?: boolean;
}) {
  // 评审 P1-11 修复：移除钮 title 直出中文改 t()（hook 须在提前 return 之前）。
  const { t } = useTranslation();
  if (toolIds.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1 align-baseline", trailing ? "ml-1" : "mr-1")}>
      {toolIds.map((id) => (
        <span
          key={id}
          className="inline-flex max-w-[10rem] items-center gap-1 rounded-md border border-border/70 bg-muted/70 px-1.5 py-0.5 align-baseline text-xs text-foreground"
          title={id}
        >
          <Blocks className="h-3 w-3 shrink-0 text-[var(--icon-config)]" />
          <span className="truncate">{toolNames[id] ?? id}</span>
          {onRemove && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(id); }}
              className="-mr-0.5 ml-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-destructive/15 hover:text-destructive"
              title={t("sessions.toolPillRemove", "删除此工具调用（重发不再携带）")}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          )}
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

/** 用户消息正文展示统一组件（M5 → v0.9.0 需求3 元数据化）：tool_ids 快照
 * → pill + 正文同一内联流。pill 数据一律来自 toolIds 元数据参数，组件本身
 * 零文本解析（展示面单源纪律 §16.3）。
 * v0.9.8 需求9-②：pill 渲染在正文**之后**（方案 B 统一末尾）——注入本来就
 * 是后缀追加（compose_tool_message 单源），原「pill 恒前置」误导用户以为
 * 工具挂在了消息开头（用户实测 #3「插件永远在最前面」）。真实插入位置的
 * 元数据方案（A）留待用户验收 B 后裁决。 */
export function UserTextWithPills({
  text,
  toolIds,
  toolNames,
}: {
  text: string;
  toolIds: string[];
  toolNames: Record<string, string>;
}) {
  return (
    <span className="whitespace-pre-wrap break-all">
      {text}
      <EmbeddedToolPills toolIds={toolIds} toolNames={toolNames} trailing />
    </span>
  );
}
