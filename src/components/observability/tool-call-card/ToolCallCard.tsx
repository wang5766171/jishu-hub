import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import type { ToolCall } from "./types";
import { StatusBadge } from "./status-badge";
import { KindIcon, kindLabel } from "./kind-icon";
import { FileReadBody } from "./bodies/FileEditBody";
import { ShellExecBody } from "./bodies/ShellExecBody";
import { SearchBody } from "./bodies/SearchBody";
import { OtherBody } from "./bodies/OtherBody";
import { useFileViewer } from "@/components/file-viewer";
import { ChevronDown, ChevronRight, FileSearch } from "lucide-react";
import { buildDiffPreview, getToolPath } from "@/lib/text-preview";

function ToolCallCardBody({ call }: { call: ToolCall }) {
  switch (call.kind) {
    case "file_read":
    case "file_write":
    case "file_edit":
    case "file_delete":
      return <FileReadBody input={call.input} output={call.output} kind={call.kind} />;
    case "shell_exec":
      return <ShellExecBody input={call.input} output={call.output} error={call.error} />;
    case "search":
      return <SearchBody input={call.input} output={call.output} />;
    default:
      return <OtherBody input={call.input} output={call.output} kind={call.kind} />;
  }
}

const statusBorder: Record<ToolCall["status"], string> = {
  pending: "border-dashed border-muted-foreground/35",
  running: "border-solid border-[var(--tool-running)]/70 shadow-[inset_3px_0_0_var(--tool-running)]",
  success: "border-solid border-[var(--tool-card-border)] shadow-[inset_3px_0_0_var(--tool-success)]",
  error: "border-solid border-[var(--tool-error)] ring-1 ring-[var(--tool-error)]/30",
  aborted: "border-solid border-muted-foreground/25 opacity-70",
};

export const ToolCallCard = memo(function ToolCallCard({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(call.status === "error");
  const { openViewer } = useFileViewer();
  const diff = call.kind === "file_edit" || call.kind === "file_write" ? buildDiffPreview(call.input) : null;
  const path = getToolPath(call.input) || (call.input.command as string) || (call.input.pattern as string) || "";
  const shortPath = path.length > 60 ? "..." + path.slice(path.length - 55) : path;
  const duration = call.startedAt && call.endedAt ? ((call.endedAt - call.startedAt) / 1000).toFixed(1) + "s" : null;
  const isFile = call.kind.startsWith("file_") && path;

  return (
    <div
      style={{ fontSize: "var(--font-size-prose)" }}
      className={cn(
        "overflow-hidden rounded-xl border bg-[var(--tool-card-bg)] text-[0.85em] shadow-sm transition-colors",
        statusBorder[call.status],
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 bg-[var(--tool-card-header-bg)] px-3 py-2 text-left hover:bg-[var(--color-accent)]/45 transition-fast"
      >
        <KindIcon kind={call.kind} />
        <span className="text-[0.73em] font-semibold text-muted-foreground uppercase tracking-wide">
          {kindLabel(call.kind)}
        </span>
        <span className="flex-1 font-mono text-[0.75em] truncate text-[var(--color-foreground)]" title={path}>
          {shortPath}
        </span>
        {diff && (
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.72em] font-semibold">
            <span className="text-green-600">+{diff.added}</span>
            <span className="text-red-600">-{diff.removed}</span>
          </span>
        )}
        {isFile && (
          <span
            role="button"
            tabIndex={0}
            title="Open file"
            onClick={(event) => {
              event.stopPropagation();
              openViewer({ kind: diff ? "diff" : "file", path, diff });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                openViewer({ kind: diff ? "diff" : "file", path, diff });
              }
            }}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--color-accent)] hover:text-foreground"
          >
            <FileSearch className="h-3.5 w-3.5" />
          </span>
        )}
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

      {expanded && (
        <div className="border-t border-border/40 px-3 py-2">
          <ToolCallCardBody call={call} />
        </div>
      )}
    </div>
  );
});
