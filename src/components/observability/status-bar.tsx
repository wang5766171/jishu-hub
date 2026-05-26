import { memo } from "react";

interface StatusBarProps {
  model?: string;
  turns?: number;
  fileCount?: number;
  errorCount?: number;
  duration?: string;
}

export const StatusBar = memo(function StatusBar({ model, turns, fileCount, errorCount, duration }: StatusBarProps) {
  if (!model && !turns && !fileCount && !errorCount) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border/30 bg-[var(--color-layer-2)]">
      {model && <span className="font-medium">{model}</span>}
      {turns != null && turns > 0 && <span>{turns} turns</span>}
      {fileCount != null && fileCount > 0 && <span>{fileCount} files</span>}
      {errorCount != null && errorCount > 0 && (
        <span className="text-[var(--tool-error)] font-medium">{errorCount} errors</span>
      )}
      {duration && <span>{duration}</span>}
    </div>
  );
});
