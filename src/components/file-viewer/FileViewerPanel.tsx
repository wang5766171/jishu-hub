import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export type ViewerTarget =
  | { kind: "file"; path: string; line?: number }
  | { kind: "diff"; path: string }
  | { kind: "history"; path: string };

interface FileViewerContextValue {
  open: boolean;
  target: ViewerTarget | null;
  openViewer: (target: ViewerTarget) => void;
  closeViewer: () => void;
}

const FileViewerContext = createContext<FileViewerContextValue>(null!);

export function FileViewerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ViewerTarget | null>(null);

  const openViewer = useCallback((t: ViewerTarget) => {
    setTarget(t);
    setOpen(true);
  }, []);

  const closeViewer = useCallback(() => {
    setOpen(false);
    setTarget(null);
  }, []);

  return (
    <FileViewerContext.Provider value={{ open, target, openViewer, closeViewer }}>
      {children}
      {open && target && (
        <div className="fixed right-0 top-11 bottom-6 w-[420px] bg-[var(--color-card)] border-l border-border shadow-lg z-40 flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
            <span className="text-xs font-medium truncate">{target.path}</span>
            <button
              onClick={closeViewer}
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              Close
            </button>
          </div>
          <div className="flex-1 overflow-auto p-3">
            <pre className="font-mono text-xs text-muted-foreground">
              File viewer: {target.kind} — {target.path}
              {"\n"}(Full diff editor coming in v0.5.x)
            </pre>
          </div>
        </div>
      )}
    </FileViewerContext.Provider>
  );
}

export function useFileViewer() {
  return useContext(FileViewerContext);
}
