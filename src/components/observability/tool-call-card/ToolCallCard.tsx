import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import type { ToolCall } from "./types";
import { StatusBadge } from "./status-badge";
import { KindIcon, kindLabel } from "./kind-icon";
import { FileReadBody } from "./bodies/FileEditBody";
import { ShellExecBody } from "./bodies/ShellExecBody";
import { SearchBody } from "./bodies/SearchBody";
import { OtherBody } from "./bodies/OtherBody";
import { ChevronDown, ChevronRight } from "lucide-react";

function ToolCallCardBody({ call }: { call: ToolCall }) {
  switch (call.kind) {
    case "file_read":
    case "file_write":
    case "file_edit":
    case "file_delete":
      return <FileReadBody input={call.input} output={call.output} />;
    case "shell_exec":
      return <ShellExecBody input={call.input} output={call.output} error={call.error} />;
    case "search":
      return <SearchBody input={call.input} output={call.output} />;
    default:
      return <OtherBody input={call.input} output={call.output} kind={call.kind} />;
  }
}

const statusBorder: Record<ToolCall["status"], string> = {
  pending: "border-dashed border-muted-foreground/30",
  running: "border-solid border-[var(--tool-running)]",
  success: "border-solid border-[var(--tool-success)]/40",
  error: "border-solid border-[var(--tool-error)]",
  aborted: "border-solid border-muted opacity-60",
};

export const ToolCallCard = memo(function ToolCallCard({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(call.status === "error");
  const path = (call.input.file_path as string) || (call.input.path as string) || (call.input.command as string) || (call.input.pattern as string) || "";
  const shortPath = path.length > 60 ? "…" + path.slice(path.length - 55) : path;
  const duration = call.startedAt && call.endedAt ? ((call.endedAt - call.startedAt) / 1000).toFixed(1) + "s" : null;

  return (
    <div
      style={{ fontSize: "var(--font-size-prose)" }}
      className={cn(
        "rounded-md border text-[0.85em] transition-colors",
        statusBorder[call.status],
        call.status === "error" && "ring-1 ring-[var(--tool-error)]/30",
      )}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-accent)]/30 transition-fast"
      >
        <KindIcon kind={call.kind} />
        <span className="text-[0.73em] font-medium text-muted-foreground uppercase tracking-wide">
          {kindLabel(call.kind)}
        </span>
        <span className="flex-1 font-mono text-[0.75em] truncate text-[var(--color-foreground)]" title={path}>
          {shortPath}
        </span>
        {duration && (
          <span className="text-[0.67em] text-muted-foreground shrink-0">{duration}</span>
        )}
        <StatusBadge status={call.status} />
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        )}
      </button>

      {/* Body */}
      {expanded && (
        <div className="px-3 pb-2 border-t border-border/30">
          <ToolCallCardBody call={call} />
        </div>
      )}
    </div>
  );
});
