import { useState, useRef, useEffect, memo } from "react";
import { useAgent } from "./AgentContext";
import { cn } from "@/lib/utils";
import { InstallAgentDialog } from "./InstallAgentDialog";
import { AgentLogo } from "./AgentLogo";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentStatus } from "./types";

export interface AgentSwitcherProps {
  /** 当前选中的 agent id（受控） */
  value: string | null;
  /** 切换回调（受控） */
  onChange: (id: string) => void;
  /** 可选：按钮内额外内容（如名称标签） */
  children?: React.ReactNode;
  /** v0.7.0：下拉框向上展开（切换器位于底部如会话 footer 时用）。默认向下。 */
  dropUp?: boolean;
}

/**
 * 智能体切换器（受控组件）。
 *
 * v0.7.0 需求一：从全局 setActive 改为受控模式，由各页面传入自身作用域的
 * value/onChange（会话页用 chatAgentId，管理页用 manageAgentId）。
 * agents 列表仍从全局 useAgent() 读取（全应用共享）。
 */
export const AgentSwitcher = memo(function AgentSwitcher({
  value,
  onChange,
  children,
  dropUp = false,
}: AgentSwitcherProps) {
  const { t } = useTranslation();
  const { agents, refreshHealth } = useAgent();
  const [open, setOpen] = useState(false);
  const [installDialogOpen, setInstallAgentDialogOpen] = useState(false);
  const [agentToInstall, setInstallAgent] = useState<AgentStatus | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const active = agents.find((a) => a.id === value) ?? null;

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
          if (!open) refreshHealth({ silent: true });
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
        <div className={cn(
          "absolute left-0 z-50 w-64 rounded-lg border border-border bg-popover p-2 shadow-lg",
          dropUp ? "bottom-full mb-1" : "top-full mt-1",
        )}>
          <div className="rounded-md bg-accent/30 px-2 py-2">
            <div className="flex items-center gap-2">
              <AgentLogo agentId={active.id} size={18} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{active.display_name}</span>
              <span className="text-[11px] text-muted-foreground">
                {activeInstalled ? t("env.ready") : t("env.notInstalled")}
              </span>
            </div>
            {active.health.error && (
              <div className="mt-1 line-clamp-2 pl-6 text-[11px] text-amber-500">
                {active.health.error}
              </div>
            )}
          </div>
          <div className="mt-3 border-t border-border/40 pt-2">
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
                  onChange(agent.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-fast hover:bg-accent/40",
                  agent.id === value && "font-medium"
                )}
              >
                <AgentLogo agentId={agent.id} size={16} />
                <div className="flex-1 min-w-0 flex items-center gap-1.5 truncate text-left">
                  <span className="truncate">{agent.display_name}</span>
                  {agent.health.version && (
                    <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">
                      v{agent.health.version}
                    </span>
                  )}
                </div>
                {!agent.health.installed && (
                  <span className="text-xs text-amber-500">{t("env.notInstalled")}</span>
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
