import { createContext, useCallback, useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, FileText, FolderSearch, GitCompare, Loader2, X } from "lucide-react";
import { invokeCommand } from "@/hooks/use-invoke";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import type { DiffPreview, DiffRow } from "@/lib/text-preview";
import { clampPanelWidth, fitPanelWidth, loadPanelWidth, savePanelWidth } from "./panel-width";

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
  const { t } = useTranslation();
  const { alert: alertDialog, dialogNode: confirmDialogNode } = useConfirmDialog();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const [content, setContent] = useState<TextFilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "diff">("preview");

  // v0.8.0 需求4：面板宽度（null = 未设置，回退默认 min(560px,44vw)）。
  const [width, setWidth] = useState<number | null>(() => loadPanelWidth());
  const widthRef = useRef<number | null>(width);
  widthRef.current = width;
  const contentScrollRef = useRef<HTMLDivElement | null>(null);

  const applyWidth = useCallback((next: number) => {
    const clamped = clampPanelWidth(next, window.innerWidth);
    widthRef.current = clamped;
    setWidth(clamped);
  }, []);

  // 窗口尺寸变化时被动 clamp（不持久化，下次恢复用户设置的值）。
  useEffect(() => {
    const onResize = () => {
      if (widthRef.current !== null) {
        setWidth(clampPanelWidth(widthRef.current, window.innerWidth));
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 左缘拖拽调整宽度（v0.8.0 需求4）。pointer capture 全程接管；拖拽中
  // 禁用文本选择，防止拖过消息区时误选内容。
  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.userSelect = "none";
  }, []);

  const handleResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      applyWidth(window.innerWidth - event.clientX);
    }
  }, [applyWidth]);

  const handleResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.style.userSelect = "";
    if (widthRef.current !== null) savePanelWidth(widthRef.current);
  }, []);

  // 双击自适应：按当前内容自然宽度（scrollWidth，whitespace-pre 不折行）放宽。
  const handleFitWidth = useCallback(() => {
    const scrollWidth = contentScrollRef.current?.scrollWidth;
    if (!scrollWidth || scrollWidth <= 0) {
      widthRef.current = null;
      setWidth(null);
      return;
    }
    applyWidth(fitPanelWidth(scrollWidth, window.innerWidth));
    savePanelWidth(widthRef.current ?? clampPanelWidth(scrollWidth, window.innerWidth));
  }, [applyWidth]);

  // v0.8.0 需求4：资源管理器定位 / 关联应用打开（失败弹结构化错误）。
  const handleReveal = useCallback(async () => {
    if (!target?.path) return;
    try {
      await invokeCommand("reveal_in_file_manager", { path: target.path });
    } catch (err) {
      void alertDialog({ title: t("fileViewer.revealFailedTitle", "打开资源管理器失败"), description: String(err) });
    }
  }, [target?.path, alertDialog, t]);

  const handleOpenWith = useCallback(async () => {
    if (!target?.path) return;
    try {
      await invokeCommand("open_with_default_app", { path: target.path });
    } catch (err) {
      void alertDialog({ title: t("fileViewer.openFailedTitle", "打开文件失败"), description: String(err) });
    }
  }, [target?.path, alertDialog, t]);

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
  const hasPath = Boolean(target?.path);

  return (
    <FileViewerContext.Provider value={{ open, target, openViewer, closeViewer }}>
      {children}
      {open && target && (
        <div
          className={cn(
            "fixed right-0 top-11 bottom-6 z-40 flex min-w-[420px] flex-col border-l border-border bg-[var(--color-card)] shadow-lg",
            width === null && "w-[min(560px,44vw)]",
          )}
          style={width !== null ? { width: `${width}px` } : undefined}
        >
          {/* 左缘拖拽条：拖动调宽，双击自适应内容宽度（v0.8.0 需求4） */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("fileViewer.resizeHandle", "调整预览宽度")}
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
            onDoubleClick={handleFitWidth}
            className="absolute left-0 top-0 bottom-0 z-10 w-1.5 cursor-ew-resize hover:bg-primary/40 active:bg-primary/60"
          />
          <div className="flex items-center gap-2 border-b border-border/30 px-3 py-2">
            <FileText className="h-4 w-4 shrink-0 text-[var(--icon-action)]" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={target.path}>
              {target.path}
            </span>
            {hasPath && (
              <>
                <button
                  onClick={() => void handleReveal()}
                  title={t("fileViewer.reveal", "在资源管理器中显示")}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <FolderSearch className="h-4 w-4" />
                </button>
                <button
                  onClick={() => void handleOpenWith()}
                  title={t("fileViewer.openWith", "用关联应用打开")}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ExternalLink className="h-4 w-4" />
                </button>
              </>
            )}
            <button
              onClick={closeViewer}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center gap-1 border-b border-border/30 px-3 pt-2">
            <TabButton active={tab === "preview"} onClick={() => setTab("preview")} icon={<FileText className="h-3.5 w-3.5" />}>
              {t("fileViewer.preview", "预览")}
            </TabButton>
            {target.kind === "diff" && (
              <TabButton active={tab === "diff"} onClick={() => setTab("diff")} icon={<GitCompare className="h-3.5 w-3.5" />}>
                {t("fileViewer.changes", "变更")}
              </TabButton>
            )}
          </div>

          <div ref={contentScrollRef} className="flex-1 overflow-auto bg-background/35">
            {tab === "diff" && target.kind === "diff" ? (
              diff ? <DiffTable diff={diff} /> : <EmptyState text={t("fileViewer.noDiff", "没有可展示的变更比对")} />
            ) : loading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("fileViewer.loading", "正在读取文本...")}
              </div>
            ) : error ? (
              <EmptyState text={error} />
            ) : content ? (
              <TextPreview content={content.content} truncated={content.truncated} />
            ) : (
              <EmptyState text={t("fileViewer.empty", "没有可预览的文本内容")} />
            )}
          </div>
        </div>
      )}
      {confirmDialogNode}
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
  const { t } = useTranslation();
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
          {t("fileViewer.truncated", "内容过长，已截断显示。")}
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
      <div className="inline-block min-w-full">
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
        "grid min-w-full grid-cols-[3rem_3rem_max-content]",
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
