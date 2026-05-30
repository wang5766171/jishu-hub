import { useState, useRef, useEffect, memo } from "react";
import { useAgent } from "./AgentContext";
import { cn } from "@/lib/utils";
import { InstallAgentDialog } from "./InstallAgentDialog";
import type { AgentStatus } from "./types";

export const AgentSwitcher = memo(function AgentSwitcher() {
  const { agents, activeId, active, setActive, refreshHealth } = useAgent();
  const [open, setOpen] = useState(false);
  const [installDialogOpen, setInstallAgentDialogOpen] = useState(false);
  const [agentToInstall, setInstallAgent] = useState<AgentStatus | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!active) return null;
  const activeInstalled = active.health.installed;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          if (!activeInstalled) {
            setInstallAgent(active);
            setInstallAgentDialogOpen(true);
            return;
          }
          setOpen(!open);
          if (!open) refreshHealth();
        }}
        className={cn(
          "relative flex h-7 w-7 items-center justify-center rounded-md transition-fast hover:bg-accent/30",
          open && "bg-accent/30"
        )}
        title={active.display_name}
        aria-label={active.display_name}
      >
        <span
          className={cn(
            "absolute h-2.5 w-2.5 rounded-full opacity-50 animate-ping",
            !activeInstalled && "bg-amber-400"
          )}
          style={activeInstalled ? { backgroundColor: "var(--floating-indicator, #10b981)" } : undefined}
        />
        <span
          className={cn(
            "relative h-2.5 w-2.5 rounded-full ring-2 ring-background",
            !activeInstalled && "bg-amber-400"
          )}
          style={activeInstalled ? { backgroundColor: "var(--floating-indicator, #10b981)" } : undefined}
        />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-64 rounded-lg border border-border bg-popover shadow-lg z-50 p-2">
          <div className="px-2 pb-2 pt-1 border-b border-border/50">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  activeInstalled ? "bg-emerald-500" : "bg-amber-400"
                )}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{active.display_name}</span>
              <span className="text-[11px] text-muted-foreground">
                {activeInstalled ? "已就绪" : "未安装"}
              </span>
            </div>
            {active.health.version && (
              <div className="mt-1 truncate pl-4 text-[11px] text-muted-foreground">
                v{active.health.version}
              </div>
            )}
            {active.health.error && (
              <div className="mt-1 line-clamp-2 pl-4 text-[11px] text-amber-500">
                {active.health.error}
              </div>
            )}
          </div>
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => {
                if (!agent.health.installed) {
                  setInstallAgent(agent);
                  setInstallAgentDialogOpen(true);
                  setOpen(false);
                  return;
                }
                setActive(agent.id);
                setOpen(false);
              }}
              className={cn(
                "w-full flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-fast hover:bg-accent/50",
                agent.id === activeId && "font-medium"
              )}
            >
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${agent.health.installed ? "bg-emerald-500" : "bg-amber-400"}`}
              />
              <span className="flex-1 text-left">{agent.display_name}</span>
              {agent.health.version && (
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  v{agent.health.version}
                </span>
              )}
              {!agent.health.installed && (
                <span className="text-xs text-amber-500">未安装</span>
              )}
            </button>
          ))}
        </div>
      )}

      <InstallAgentDialog
        agent={agentToInstall}
        open={installDialogOpen}
        onOpenChange={setInstallAgentDialogOpen}
        onInstalled={refreshHealth}
      />
    </div>
  );
});
