import { memo } from "react";

export const FileReadBody = memo(function FileReadBody({ input, output }: { input: Record<string, unknown>; output?: string }) {
  const path = (input.file_path as string) || (input.path as string) || "";
  const offset = input.offset as number | undefined;
  const limit = input.limit as number | undefined;
  const lineRange = offset && limit ? `:${offset}-${offset + limit}` : "";

  return (
    <div className="text-[0.75em] space-y-1">
      {path && (
        <div className="font-mono text-[var(--color-foreground)] opacity-80 truncate" title={path}>
          {path}{lineRange}
        </div>
      )}
      {output && (
        <pre className="font-mono text-[0.73em] bg-[var(--color-muted)] rounded p-2 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre">
          {output.length > 2000 ? output.slice(0, 2000) + "\n… (truncated)" : output}
        </pre>
      )}
    </div>
  );
});
