import { memo, useMemo } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildDiffPreview, getReadableInputPreview, getToolPath, type DiffPreview, type DiffRow } from "@/lib/text-preview";
import { wordDiff, type DiffToken } from "@/lib/word-diff";

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
        <pre className="max-h-56 overflow-auto whitespace-pre rounded-[6px] border border-border/45 bg-[var(--tool-card-code-bg)] p-2.5 font-mono text-[0.95em]">
          {readable.length > 2400 ? `${readable.slice(0, 2400)}\n... (truncated)` : readable}
        </pre>
      ) : output ? (
        <pre className="max-h-48 overflow-auto whitespace-pre rounded-[6px] border border-border/45 bg-[var(--tool-card-code-bg)] p-2.5 font-mono text-[0.95em]">
          {output.length > 2000 ? `${output.slice(0, 2000)}\n... (truncated)` : output}
        </pre>
      ) : null}
    </div>
  );
});

// v0.8.0 需求1 B2：词级高亮的性能护栏——超出任一上限时保持行级渲染。
const WORD_DIFF_MAX_ROWS = 2000;
const WORD_DIFF_MAX_PAIRS = 500;

/**
 * 对相邻的 remove/add 行对逐对做词级比对，返回按行索引存放的 token 序列
 * （未配对/完全一致的行为 null，走整行渲染）。remove 与 add 逐位配对
 * （经典 diff hunk 语义），多余的不配对行保持整行着色。
 */
function computeWordHighlights(rows: DiffRow[]): (DiffToken[] | null)[] {
  if (rows.length === 0 || rows.length > WORD_DIFF_MAX_ROWS) return [];
  const highlights: (DiffToken[] | null)[] = new Array(rows.length).fill(null);
  let pairs = 0;
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "remove") {
      i += 1;
      continue;
    }
    let removeEnd = i;
    while (removeEnd < rows.length && rows[removeEnd].kind === "remove") removeEnd += 1;
    let addEnd = removeEnd;
    while (addEnd < rows.length && rows[addEnd].kind === "add") addEnd += 1;
    if (addEnd > removeEnd) {
      const pairCount = Math.min(removeEnd - i, addEnd - removeEnd);
      for (let p = 0; p < pairCount; p += 1) {
        pairs += 1;
        if (pairs > WORD_DIFF_MAX_PAIRS) return highlights;
        const result = wordDiff(rows[i + p].text, rows[removeEnd + p].text);
        if (!result) continue;
        highlights[i + p] = result.oldTokens;
        highlights[removeEnd + p] = result.newTokens;
      }
    }
    i = addEnd;
  }
  return highlights;
}

function InlineDiff({ diff }: { diff: DiffPreview }) {
  const wordHighlights = useMemo(() => computeWordHighlights(diff.rows), [diff.rows]);
  return (
    <div className="overflow-hidden rounded-[6px] border border-border/50 bg-background/45">
      <div className="flex items-center gap-2 border-b border-border/40 bg-[var(--tool-card-header-bg)] px-2.5 py-1.5">
        <FileText className="h-3.5 w-3.5 text-[var(--icon-action)]" />
        <span className="min-w-0 flex-1 truncate font-sans text-[0.95em] font-medium">{diff.fileName}</span>
        <span className="font-sans text-[0.95em] font-semibold text-green-600">+{diff.added}</span>
        <span className="font-sans text-[0.95em] font-semibold text-red-600">-{diff.removed}</span>
      </div>
      <div className="max-h-72 overflow-auto font-mono text-[0.95em]">
        <div className="inline-block min-w-full">
          {diff.rows.map((row, index) => (
            <DiffLine key={index} row={row} tokens={wordHighlights[index] ?? null} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DiffLine({ row, tokens }: { row: DiffRow; tokens?: DiffToken[] | null }) {
  return (
    <div
      className={cn(
        "grid min-w-full grid-cols-[2.7rem_2.7rem_max-content]",
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
        {tokens && tokens.length > 0
          ? tokens.map((token, index) =>
              token.changed ? (
                <span
                  key={index}
                  className={cn(
                    "rounded-[2px]",
                    row.kind === "add" ? "bg-emerald-500/35" : "bg-red-500/35",
                  )}
                >
                  {token.text}
                </span>
              ) : (
                <span key={index}>{token.text}</span>
              ),
            )
          : row.text || " "}
      </span>
    </div>
  );
}
