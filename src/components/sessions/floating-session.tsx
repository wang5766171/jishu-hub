import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2, Bot, X, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentStreamChunk } from "@/types";

// Apply theme from localStorage for floating window
function applyStoredTheme() {
  const theme = localStorage.getItem("jishu-hub-theme") || "dark";
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * Floating mini window content for monitoring a session's streaming status.
 * Rendered when the app detects `?floating=<sessionId>` in the URL.
 */
export function FloatingSessionView() {
  const { t } = useTranslation();
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("floating") || "";
  const sessionName = decodeURIComponent(params.get("name") || sessionId.slice(0, 8));
  const agentId = params.get("agent") || "";
  const agentName = decodeURIComponent(params.get("agentName") || agentId);
  const projectEncoded = params.get("project") || "";

  const handleRestore = useCallback(async () => {
    await emit("floating-restore", { sessionId, agentId, projectEncoded });
    getCurrentWindow().destroy();
  }, [sessionId, agentId, projectEncoded]);

  const [status, setStatus] = useState<"idle" | "running" | "complete">("idle");
  const [lastText, setLastText] = useState("");
  const [toolName, setToolName] = useState("");
  const textRef = useRef("");

  // Apply theme on mount
  useEffect(() => { applyStoredTheme(); }, []);

  // Enable window dragging on the title area
  const handleDrag = useCallback(async (e: React.MouseEvent) => {
    if (e.button === 0) {
      await getCurrentWindow().startDragging();
    }
  }, []);

  // Listen to agent-event for this session
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;

    listen<AgentStreamChunk[] | AgentStreamChunk>("agent-event", (event) => {
      const chunks = Array.isArray(event.payload) ? event.payload : [event.payload];
      for (const chunk of chunks) {
        if (chunk.session_id !== sessionId) continue;
        if (agentId && chunk.agent_id !== agentId) continue;

        if (chunk.data.kind === "text_delta") {
          setStatus("running");
          textRef.current += chunk.data.delta;
          // Show last ~60 chars
          const t = textRef.current;
          setLastText(t.length > 60 ? "..." + t.slice(-57) : t);
        } else if (chunk.data.kind === "thinking") {
          setStatus("running");
        } else if (chunk.data.kind === "tool_use_start") {
          setStatus("running");
          setToolName(chunk.data.tool);
        } else if (chunk.data.kind === "turn_complete") {
          setStatus("complete");
          textRef.current = "";
        } else if (chunk.data.kind === "error") {
          setStatus("complete");
        }
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenFn = fn;
    });

    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, [sessionId]);

  // Also listen for new messages sent (reset to running)
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;

    listen<{ session_id: string }>("chat-message-sent", (event) => {
      if (event.payload.session_id === sessionId) {
        setStatus("running");
        textRef.current = "";
        setLastText("");
        setToolName("");
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenFn = fn;
    });

    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, [sessionId]);

  return (
    <div className="flex flex-col h-screen w-screen select-none overflow-hidden bg-background border border-border/50 rounded-lg">
      {/* Draggable title bar */}
      <div
        onMouseDown={handleDrag}
        className="flex items-center gap-2 px-3 h-8 shrink-0 border-b-2 border-border cursor-move"
        style={{ background: "var(--color-layer-1, var(--color-card))" }}
      >
        <span className="flex h-3 w-3 shrink-0 items-center justify-center text-muted-foreground">
          <Bot className="h-3 w-3" />
        </span>
        <span className="text-xs font-medium truncate flex-1" title={sessionName}>{sessionName}</span>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleRestore}
          className="h-4 w-4 flex items-center justify-center rounded-full opacity-60 hover:opacity-100 hover:bg-muted-foreground/20 transition-all ml-1.5"
          title={t("sessions.floatingRestore", "恢复")}
        >
          <Maximize2 className="h-2.5 w-2.5" />
        </button>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => { getCurrentWindow().destroy(); }}
          className="h-4 w-4 flex items-center justify-center rounded-full opacity-60 hover:opacity-100 hover:bg-muted-foreground/20 transition-all ml-1"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </div>

      {/* Agent row: status indicator + agent display name */}
      <div
        onMouseDown={handleDrag}
        className="flex items-center gap-2 px-3 h-6 shrink-0 border-b border-border/30 cursor-move"
        style={{ background: "var(--color-layer-1, var(--color-card))" }}
      >
        <span className="flex h-3 w-3 shrink-0 items-center justify-center">
          <StatusIndicator status={status} />
        </span>
        <span
          className="text-[11px] text-muted-foreground truncate"
          title={agentName}
        >
          {agentName}
        </span>
      </div>

      {/* Content area */}
      <div className="flex-1 flex items-center px-3 py-2 min-h-0">
        {status === "idle" && (
          <span className="text-xs text-muted-foreground">{t("sessions.floatingIdle", "等待任务...")}</span>
        )}
        {status === "running" && (
          <div className="flex flex-col gap-1 min-w-0 w-full">
            {toolName && (
              <div className="flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
                <span className="text-xs text-foreground font-medium truncate">{toolName}</span>
              </div>
            )}
            {lastText && (
              <p className="text-[11px] text-muted-foreground truncate leading-tight">{lastText}</p>
            )}
            {!toolName && !lastText && (
              <div className="flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
                <span className="text-xs text-muted-foreground">{t("sessions.thinkingDots")}</span>
              </div>
            )}
          </div>
        )}
        {status === "complete" && (
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
            <span className="text-xs font-medium text-green-600 dark:text-green-400">
              {t("sessions.floatingComplete", "任务已完成")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusIndicator({ status }: { status: "idle" | "running" | "complete" }) {
  return (
    <div
      className={cn(
        "h-2 w-2 rounded-full shrink-0",
        status === "idle" && "bg-muted-foreground/40",
        status === "running" && "animate-pulse",
        status === "complete" && "bg-green-500",
      )}
      style={status === "running" ? { backgroundColor: "var(--floating-indicator, var(--color-primary))" } : undefined}
    />
  );
}
