import { memo } from "react";

export const ShellExecBody = memo(function ShellExecBody({ input, output, error }: { input: Record<string, unknown>; output?: string; error?: string }) {
  const command = (input.command as string) || "";
  const cwd = input.cwd as string | undefined;

  return (
    <div className="text-[0.95em] space-y-2">
      <div className="flex items-start gap-2">
        <span className="text-muted-foreground">$</span>
        <code className="font-mono text-[var(--color-foreground)] break-all">{command}</code>
      </div>
      {cwd && (
        <div className="text-[0.85em] text-muted-foreground font-mono truncate" title={cwd}>
          cwd: {cwd}
        </div>
      )}
      {output && (
        <pre className={`font-mono text-[0.95em] bg-[var(--tool-card-code-bg)] border border-border/45 rounded-lg p-2.5 overflow-x-auto max-h-56 overflow-y-auto whitespace-pre ${error ? "text-[var(--tool-error)]" : ""}`}>
          {output.length > 3000 ? output.slice(0, 3000) + "\n... (truncated)" : output}
        </pre>
      )}
      {error && (
        <div className="text-[0.95em] text-[var(--tool-error)] font-mono bg-red-500/10 border border-[var(--tool-error)]/25 rounded-lg p-2.5">
          {error}
        </div>
      )}
    </div>
  );
});
