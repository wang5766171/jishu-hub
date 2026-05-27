import { memo } from "react";

export const SearchBody = memo(function SearchBody({ input, output }: { input: Record<string, unknown>; output?: string }) {
  const pattern = (input.pattern as string) || (input.glob as string) || "";
  const path = (input.path as string) || "";

  return (
    <div className="text-[0.75em] space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono font-medium">{pattern}</span>
        {path && <span className="text-muted-foreground">in: {path}</span>}
      </div>
      {output && (
        <pre className="font-mono text-[0.73em] bg-[var(--tool-card-code-bg)] border border-border/45 rounded-lg p-2 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre">
          {output.length > 2000 ? output.slice(0, 2000) + "\n… (truncated)" : output}
        </pre>
      )}
    </div>
  );
});
