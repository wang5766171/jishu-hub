import { memo } from "react";
import type { ToolKind } from "../types";
import { kindLabel } from "../kind-icon";

export const OtherBody = memo(function OtherBody({ input, output, kind }: { input: Record<string, unknown>; output?: string; kind: ToolKind }) {
  return (
    <div className="text-[0.95em] space-y-2">
      <div className="text-[0.85em] text-muted-foreground uppercase tracking-wide">{kindLabel(kind)}</div>
      {Object.keys(input).length > 0 && (
        <pre className="font-mono text-[0.95em] bg-[var(--tool-card-code-bg)] border border-border/45 rounded-[6px] p-2.5 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre">
          {JSON.stringify(input, null, 2).slice(0, 2000)}
        </pre>
      )}
      {output && (
        <pre className="font-mono text-[0.95em] bg-[var(--tool-card-code-bg)] border border-border/45 rounded-[6px] p-2.5 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre">
          {output.length > 2000 ? output.slice(0, 2000) + "\n… (truncated)" : output}
        </pre>
      )}
    </div>
  );
});
