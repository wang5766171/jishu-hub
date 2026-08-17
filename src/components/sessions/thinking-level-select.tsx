// v0.7.4 需求1 A7：thinking 档位选择器（模型选择器/水位圆环同一控制区）。
// 选项来自 adapter 声明（AgentStatus.thinking_levels），显示值优先取会话
// 内事件回传的生效值（Pi clamp 后），回退 Hub 持久化值。切换即写 Hub
// 持久化 + 活跃会话即时下发（Pi 侧同时持久化为默认级别）。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brain, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const LEVEL_LABEL_KEYS: Record<string, string> = {
  off: "sessions.thinkingLevel.off",
  minimal: "sessions.thinkingLevel.minimal",
  low: "sessions.thinkingLevel.low",
  medium: "sessions.thinkingLevel.medium",
  high: "sessions.thinkingLevel.high",
  xhigh: "sessions.thinkingLevel.xhigh",
  max: "sessions.thinkingLevel.max",
};

export function thinkingLevelLabel(t: (k: string) => string, level: string): string {
  const key = LEVEL_LABEL_KEYS[level];
  return key ? t(key) : level;
}

export function ThinkingLevelSelect({
  levels,
  value,
  onChange,
}: {
  levels: string[];
  /** 会话内生效值（事件回传）或 Hub 持久化值 */
  value: string | null;
  onChange: (level: string) => void;
}) {
  const { t } = useTranslation();
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

  if (levels.length === 0) return null;
  const current = value && levels.includes(value) ? value : null;

  return (
    <div ref={rootRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={t("sessions.thinkingLevel.title")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("sessions.thinkingLevel.hint")}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-md text-xs text-muted-foreground transition-fast hover:bg-accent/30 hover:text-foreground",
          open && "bg-accent/30 text-foreground",
          current === null && "opacity-70",
        )}
      >
        <Brain className="h-3.5 w-3.5" />
        <span>{current ? thinkingLevelLabel(t, current) : t("sessions.thinkingLevel.unset")}</span>
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 z-50 w-40 rounded-lg border border-border bg-popover p-1 shadow-lg">
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              className={cn(
                "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs",
                level === current ? "bg-primary/10 text-primary" : "hover:bg-accent/50",
              )}
              onClick={() => {
                onChange(level);
                setOpen(false);
              }}
            >
              {thinkingLevelLabel(t, level)}
              {level === current && <Check className="h-3 w-3" />}
            </button>
          ))}
          <p className="px-2 py-1 text-[10px] leading-snug text-muted-foreground/70">
            {t("sessions.thinkingLevel.clampHint")}
          </p>
        </div>
      )}
    </div>
  );
}
