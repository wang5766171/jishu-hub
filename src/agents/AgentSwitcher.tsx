import { useState, useRef, useEffect, memo } from "react";
import { useAgent } from "./AgentContext";
import { cn } from "@/lib/utils";
import { InstallAgentDialog } from "./InstallAgentDialog";
import { AgentLogo } from "./AgentLogo";
import { ChevronDown } from "lucide-react";
import type { AgentStatus } from "./types";

export const AgentSwitcher = memo(function AgentSwitcher({ children }: { children?: React.ReactNode }) {
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
          "relative flex h-7 items-center gap-1.5 rounded-md transition-fast hover:bg-accent/30",
          open && "bg-accent/30"
        )}
        title={active.display_name}
        aria-label={active.display_name}
      >
        <AgentLogo agentId={active.id} size={18} />
        {children}
        <ChevronDown className={cn(
          "h-3.5 w-3.5 text-muted-foreground transition-transform",
          open && "rotate-180"
        )} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-popover p-2 shadow-lg">
          <div className="rounded-md bg-accent/30 px-2 py-2">
            <div className="flex items-center gap-2">
              <AgentLogo agentId={active.id} size={18} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{active.display_name}</span>
              <span className="text-[11px] text-muted-foreground">
                {activeInstalled ? "已就绪" : "未安装"}
              </span>
            </div>
            {active.health.error && (
              <div className="mt-1 line-clamp-2 pl-6 text-[11px] text-amber-500">
                {active.health.error}
              </div>
            )}
          </div>
          <div className="mt-2">
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
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-fast hover:bg-accent/40",
                  agent.id === activeId && "font-medium"
                )}
              >
                <AgentLogo agentId={agent.id} size={16} />
                <span className="flex-1 truncate text-left">{agent.display_name}</span>
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
