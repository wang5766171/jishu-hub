import { memo, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCallCard } from "./ToolCallCard";
import type { ToolCall } from "./types";

interface ToolGroupProps {
  calls: ToolCall[];
  defaultExpanded?: boolean;
}

export const ToolGroup = memo(function ToolGroup({ calls, defaultExpanded }: ToolGroupProps) {
  const hasError = calls.some((c) => c.status === "error");
  const [expanded, setExpanded] = useState(defaultExpanded ?? hasError);
  const summary = useMemo(() => buildSummary(calls), [calls]);

  if (calls.length === 1) {
    return <ToolCallCard call={calls[0]} />;
  }

  return (
    <div
      style={{ fontSize: "var(--font-size-prose)" }}
      className={cn(
        "overflow-hidden rounded-[8px] border bg-[var(--tool-card-bg)] text-[1em] shadow-sm transition-colors",
        hasError
          ? "border-[var(--tool-error)] ring-1 ring-[var(--tool-error)]/30"
          : "border-[var(--tool-card-border)]",
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 bg-[var(--tool-card-header-bg)] px-3 py-2 text-left hover:bg-[var(--color-accent)]/45 transition-fast"
      >
        <span className="text-[0.95em] font-semibold text-[var(--color-foreground)] truncate">
          {summary}
        </span>
        <span className="ml-auto rounded-full bg-background/70 px-1.5 py-0.5 text-[0.82em] text-muted-foreground shrink-0">
          {calls.length} {"\u9879"}
        </span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="space-y-1.5 border-t border-border/40 p-2">
          {calls.map((call) => (
            <ToolCallCard key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  );
});

function buildSummary(calls: ToolCall[]): string {
  const counts: Partial<Record<ToolCall["kind"], number>> = {};
  for (const c of calls) counts[c.kind] = (counts[c.kind] ?? 0) + 1;

  const parts: string[] = [];
  for (const [kind, n] of Object.entries(counts)) {
    if (!n) continue;
    parts.push(`${verbFor(kind as ToolCall["kind"])} ${n} ${unitFor(kind as ToolCall["kind"])}`);
  }
  return parts.join(" \u00b7 ");
}

function verbFor(kind: ToolCall["kind"]): string {
  switch (kind) {
    case "file_read":
      return "\u8bfb\u53d6";
    case "file_edit":
      return "\u7f16\u8f91";
    case "file_write":
      return "\u5199\u5165";
    case "file_delete":
      return "\u5220\u9664";
    case "shell_exec":
      return "\u6267\u884c";
    case "search":
      return "\u641c\u7d22";
    case "web":
      return "\u8bf7\u6c42";
    case "think":
      return "\u601d\u8003";
    case "subtask":
      return "\u4efb\u52a1";
    default:
      return "\u8c03\u7528";
  }
}

function unitFor(kind: ToolCall["kind"]): string {
  switch (kind) {
    case "file_read":
    case "file_edit":
    case "file_write":
    case "file_delete":
      return "\u4e2a\u6587\u4ef6";
    case "shell_exec":
      return "\u6761\u547d\u4ee4";
    case "subtask":
      return "\u9879";
    default:
      return "\u6b21";
  }
}
