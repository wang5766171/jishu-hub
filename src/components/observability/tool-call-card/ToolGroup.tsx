import { memo, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCallCard } from "./ToolCallCard";
import type { ToolCall } from "./types";
import { kindLabel } from "./kind-icon";

interface ToolGroupProps {
  calls: ToolCall[];
  /** 是否默认展开（包含 error 时强制展开） */
  defaultExpanded?: boolean;
}

/**
 * 把若干连续工具调用合并为一张折叠卡，参考 Codex「已编辑 N 个文件」聚合样式。
 * 单个调用不走 group，直接渲染 ToolCallCard。
 */
export const ToolGroup = memo(function ToolGroup({ calls, defaultExpanded }: ToolGroupProps) {
  const hasError = calls.some((c) => c.status === "error");
  const [expanded, setExpanded] = useState(defaultExpanded ?? hasError);

  const summary = useMemo(() => buildSummary(calls), [calls]);

  // 单个调用不需要聚合外壳
  if (calls.length === 1) {
    return <ToolCallCard call={calls[0]} />;
  }

  return (
    <div
      style={{ fontSize: "var(--font-size-prose)" }}
      className={cn(
        "rounded-md border text-[0.85em] transition-colors",
        hasError
          ? "border-[var(--tool-error)] ring-1 ring-[var(--tool-error)]/30"
          : "border-border/60",
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-accent)]/30 transition-fast"
      >
        <span className="text-[0.78em] font-medium text-[var(--color-foreground)] truncate">
          {summary}
        </span>
        <span className="ml-auto text-[0.7em] text-muted-foreground shrink-0">
          {calls.length} 项
        </span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-2 py-1.5 border-t border-border/30 space-y-1">
          {calls.map((call) => (
            <ToolCallCard key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  );
});

/** 生成「编辑 3 个文件 · 执行 2 条命令」之类的摘要 */
function buildSummary(calls: ToolCall[]): string {
  const counts: Partial<Record<ToolCall["kind"], number>> = {};
  for (const c of calls) counts[c.kind] = (counts[c.kind] ?? 0) + 1;

  const parts: string[] = [];
  for (const [kind, n] of Object.entries(counts)) {
    if (!n) continue;
    parts.push(`${verbFor(kind as ToolCall["kind"])} ${n} ${unitFor(kind as ToolCall["kind"])}`);
  }
  return parts.join(" · ");
}

function verbFor(kind: ToolCall["kind"]): string {
  switch (kind) {
    case "file_read":
      return "读取";
    case "file_edit":
      return "编辑";
    case "file_write":
      return "写入";
    case "file_delete":
      return "删除";
    case "shell_exec":
      return "执行";
    case "search":
      return "搜索";
    case "web":
      return "请求";
    case "think":
      return "思考";
    case "subtask":
      return "派发";
    default:
      return "调用";
  }
}

function unitFor(kind: ToolCall["kind"]): string {
  switch (kind) {
    case "file_read":
    case "file_edit":
    case "file_write":
    case "file_delete":
      return "个文件";
    case "shell_exec":
      return "条命令";
    case "search":
      return "次";
    case "web":
      return "次";
    case "think":
      return "次";
    case "subtask":
      return "项";
    default:
      return `次 ${kindLabel(kind)}`;
  }
}
