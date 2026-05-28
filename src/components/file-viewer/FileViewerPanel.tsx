import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { FileText, GitCompare, Loader2, X } from "lucide-react";
import { invokeCommand } from "@/hooks/use-invoke";
import { cn } from "@/lib/utils";
import type { DiffPreview, DiffRow } from "@/lib/text-preview";

export type ViewerTarget =
  | { kind: "file"; path: string; line?: number }
  | { kind: "diff"; path: string; diff?: DiffPreview | null }
  | { kind: "history"; path: string };

interface FileViewerContextValue {
  open: boolean;
  target: ViewerTarget | null;
  openViewer: (target: ViewerTarget) => void;
  closeViewer: () => void;
}

interface TextFilePreview {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
}

const FileViewerContext = createContext<FileViewerContextValue>(null!);

export function FileViewerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const [content, setContent] = useState<TextFilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "diff">("preview");

  const openViewer = useCallback((t: ViewerTarget) => {
    setTarget(t);
    setTab(t.kind === "diff" ? "diff" : "preview");
    setOpen(true);
  }, []);

  const closeViewer = useCallback(() => {
    setOpen(false);
    setTarget(null);
  }, []);

  useEffect(() => {
    if (!open || !target?.path) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);

    invokeCommand<TextFilePreview>("read_text_file", { path: target.path })
      .then((result) => {
        if (!cancelled) setContent(result);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, target?.path]);

  const diff = target?.kind === "diff" ? target.diff : null;

  return (
    <FileViewerContext.Provider value={{ open, target, openViewer, closeViewer }}>
      {children}
      {open && target && (
        <div className="fixed right-0 top-11 bottom-6 z-40 flex w-[min(560px,44vw)] min-w-[420px] flex-col border-l border-border bg-[var(--color-card)] shadow-lg">
          <div className="flex items-center gap-2 border-b border-border/30 px-3 py-2">
            <FileText className="h-4 w-4 shrink-0 text-[var(--icon-action)]" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={target.path}>
              {target.path}
            </span>
            <button
              onClick={closeViewer}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center gap-1 border-b border-border/30 px-3 pt-2">
            <TabButton active={tab === "preview"} onClick={() => setTab("preview")} icon={<FileText className="h-3.5 w-3.5" />}>
              预览
            </TabButton>
            {target.kind === "diff" && (
              <TabButton active={tab === "diff"} onClick={() => setTab("diff")} icon={<GitCompare className="h-3.5 w-3.5" />}>
                变更
              </TabButton>
            )}
          </div>

          <div className="flex-1 overflow-auto bg-background/35">
            {tab === "diff" && target.kind === "diff" ? (
              diff ? <DiffTable diff={diff} /> : <EmptyState text="没有可展示的变更比对" />
            ) : loading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在读取文本...
              </div>
            ) : error ? (
              <EmptyState text={error} />
            ) : content ? (
              <TextPreview content={content.content} truncated={content.truncated} />
            ) : (
              <EmptyState text="没有可预览的文本内容" />
            )}
          </div>
        </div>
      )}
    </FileViewerContext.Provider>
  );
}

function TabButton({
  active,
  children,
  icon,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-t-lg px-3 py-1.5 text-sm transition-fast",
        active
          ? "border-b-2 border-foreground bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function TextPreview({ content, truncated }: { content: string; truncated: boolean }) {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  return (
    <div className="font-mono text-[var(--font-size-prose)]">
      {lines.map((line, index) => (
        <div key={index} className="grid grid-cols-[3.5rem_minmax(0,1fr)]">
          <span className="select-none border-r border-border/35 px-3 py-0.5 text-right text-muted-foreground/70">
            {index + 1}
          </span>
          <span className="whitespace-pre px-3 py-0.5 text-foreground/80">{line || " "}</span>
        </div>
      ))}
      {truncated && (
        <div className="border-t border-border/40 px-3 py-2 text-sm text-muted-foreground">
          内容过长，已截断显示。
        </div>
      )}
    </div>
  );
}

function DiffTable({ diff }: { diff: DiffPreview }) {
  return (
    <div className="font-mono text-[var(--font-size-prose)]">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/40 bg-[var(--color-card)] px-3 py-2">
        <FileText className="h-4 w-4 text-[var(--icon-action)]" />
        <span className="flex-1 truncate font-sans text-sm font-medium">{diff.fileName}</span>
        <span className="font-sans text-sm font-semibold text-green-600">+{diff.added}</span>
        <span className="font-sans text-sm font-semibold text-red-600">-{diff.removed}</span>
      </div>
      {diff.rows.map((row, index) => (
        <DiffLine key={index} row={row} />
      ))}
    </div>
  );
}

function DiffLine({ row }: { row: DiffRow }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[3rem_3rem_minmax(0,1fr)]",
        row.kind === "add" && "bg-[var(--diff-added)] text-[var(--diff-added-fg)]",
        row.kind === "remove" && "bg-[var(--diff-removed)] text-[var(--diff-removed-fg)]",
      )}
    >
      <span className="select-none border-r border-border/25 px-2 py-0.5 text-right text-muted-foreground/70">
        {row.oldLine ?? ""}
      </span>
      <span className="select-none border-r border-border/25 px-2 py-0.5 text-right text-muted-foreground/70">
        {row.newLine ?? ""}
      </span>
      <span className="whitespace-pre px-3 py-0.5">
        {row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}
        {row.text || " "}
      </span>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

export function useFileViewer() {
  return useContext(FileViewerContext);
}
