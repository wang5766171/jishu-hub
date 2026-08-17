// v0.7.4 R17 迭代二：项目编辑头部的智能体下拉（带图标，样式对齐模型设置页
// 的卡片式下拉）。选项 = 识别当前项目的智能体（project.agent_ids）。

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentLogo } from "@/agents";
import type { AgentStatus } from "@/agents";

export function AgentSelect({
  agents,
  value,
  onChange,
  disabled,
}: {
  agents: AgentStatus[];
  value: string;
  onChange: (agentId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const current = agents.find((a) => a.id === value) ?? null;

  return (
    <div ref={rootRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        disabled={disabled || agents.length === 0}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-8 max-w-[180px] items-center gap-1.5 rounded-md border border-input bg-transparent px-2 text-xs transition-fast",
          "hover:bg-accent/30",
          open && "ring-1 ring-ring",
          (disabled || agents.length === 0) && "opacity-50",
        )}
        title={current?.display_name ?? ""}
      >
        {current && <AgentLogo agentId={current.id} size={16} />}
        <span className="truncate">{current?.display_name ?? "--"}</span>
        <ChevronDown
          className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[180px] rounded-lg border border-border bg-popover p-1 shadow-lg">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-fast",
                agent.id === value
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-accent/50",
              )}
              onClick={() => {
                onChange(agent.id);
                setOpen(false);
              }}
            >
              <AgentLogo agentId={agent.id} size={16} />
              <span className="min-w-0 flex-1 truncate">{agent.display_name}</span>
              {agent.id === value && <Check className="h-3 w-3 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
