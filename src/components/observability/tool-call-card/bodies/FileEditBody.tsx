import { memo } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildDiffPreview, getReadableInputPreview, getToolPath, type DiffPreview, type DiffRow } from "@/lib/text-preview";

export const FileReadBody = memo(function FileReadBody({
  input,
  output,
  kind,
}: {
  input: Record<string, unknown>;
  output?: string;
  kind?: string;
}) {
  const path = getToolPath(input);
  const offset = input.offset as number | undefined;
  const limit = input.limit as number | undefined;
  const lineRange = offset && limit ? `:${offset}-${offset + limit}` : "";
  const diff = kind === "file_edit" || kind === "file_write" ? buildDiffPreview(input) : null;
  const readable = getReadableInputPreview(input);

  return (
    <div className="space-y-2 text-[0.95em]">
      {path && (
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[var(--color-foreground)] opacity-80">
          <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--icon-action)]" />
          <span className="truncate" title={path}>
            {path}
            {lineRange}
          </span>
        </div>
      )}

      {diff ? (
        <InlineDiff diff={diff} />
      ) : readable ? (
        <pre className="max-h-56 overflow-auto whitespace-pre rounded-lg border border-border/45 bg-[var(--tool-card-code-bg)] p-2.5 font-mono text-[0.95em]">
          {readable.length > 2400 ? `${readable.slice(0, 2400)}\n... (truncated)` : readable}
        </pre>
      ) : output ? (
        <pre className="max-h-48 overflow-auto whitespace-pre rounded-lg border border-border/45 bg-[var(--tool-card-code-bg)] p-2.5 font-mono text-[0.95em]">
          {output.length > 2000 ? `${output.slice(0, 2000)}\n... (truncated)` : output}
        </pre>
      ) : null}
    </div>
  );
});

function InlineDiff({ diff }: { diff: DiffPreview }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-background/45">
      <div className="flex items-center gap-2 border-b border-border/40 bg-[var(--tool-card-header-bg)] px-2.5 py-1.5">
        <FileText className="h-3.5 w-3.5 text-[var(--icon-action)]" />
        <span className="min-w-0 flex-1 truncate font-sans text-[0.95em] font-medium">{diff.fileName}</span>
        <span className="font-sans text-[0.95em] font-semibold text-green-600">+{diff.added}</span>
        <span className="font-sans text-[0.95em] font-semibold text-red-600">-{diff.removed}</span>
      </div>
      <div className="max-h-72 overflow-auto font-mono text-[0.95em]">
        {diff.rows.map((row, index) => (
          <DiffLine key={index} row={row} />
        ))}
      </div>
    </div>
  );
}

function DiffLine({ row }: { row: DiffRow }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[2.7rem_2.7rem_minmax(0,1fr)]",
        row.kind === "add" && "bg-[var(--diff-added)] text-[var(--diff-added-fg)]",
        row.kind === "remove" && "bg-[var(--diff-removed)] text-[var(--diff-removed-fg)]",
      )}
    >
      <span className="select-none border-r border-border/20 px-2 py-0.5 text-right text-muted-foreground/65">
        {row.oldLine ?? ""}
      </span>
      <span className="select-none border-r border-border/20 px-2 py-0.5 text-right text-muted-foreground/65">
        {row.newLine ?? ""}
      </span>
      <span className="whitespace-pre px-2 py-0.5">
        {row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}
        {row.text || " "}
      </span>
    </div>
  );
}
