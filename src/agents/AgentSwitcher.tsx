import { useState, useRef, useEffect, memo } from "react";
import { useAgent } from "./AgentContext";

export const AgentSwitcher = memo(function AgentSwitcher() {
  const { agents, activeId, active, setActive, refreshHealth } = useAgent();
  const [open, setOpen] = useState(false);
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

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          setOpen(!open);
          if (!open) refreshHealth();
        }}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm transition-colors hover:bg-[var(--color-accent)]"
      >
        <span
          className={`w-2 h-2 rounded-full ${active.health.installed ? "bg-emerald-500" : "bg-amber-400"}`}
        />
        <span>{active.display_name}</span>
        <svg
          className="w-3.5 h-3.5 opacity-60"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-[var(--color-popover)] border border-[var(--color-border)] rounded-lg shadow-lg z-50 py-1">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => {
                setActive(agent.id);
                setOpen(false);
              }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-[var(--color-accent)] ${agent.id === activeId ? "font-medium" : ""}`}
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
    </div>
  );
});
