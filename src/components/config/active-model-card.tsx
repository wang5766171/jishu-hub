// v0.7.4 需求2 R3：当前模型大卡（两 agent 统一的模型展示/切换入口）。
// 扁平 provider/model 列表单选（与聊天页模型选择器同一心智）；
// claude 侧开启 allowCustom 支持自由输入任意模型 ID。

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Box, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ActiveModelOption {
  /** 唯一值：jishu 为 "provider/model"，claude 为模型 ID */
  value: string;
  /** 主标签（模型名） */
  label: string;
  /** 副标签（供应商等） */
  hint?: string;
}

export function ActiveModelCard({
  current,
  options,
  onSelect,
  allowCustom = false,
  customPlaceholder,
  emptyHint,
  emptyActionLabel,
  onEmptyAction,
}: {
  /** 当前值（value 形式）；null = 未配置 */
  current: ActiveModelOption | null;
  options: ActiveModelOption[];
  onSelect: (value: string) => void;
  allowCustom?: boolean;
  customPlaceholder?: string;
  /** 未配置任何模型时的提示 */
  emptyHint?: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const filtered = useMemo(() => {
    const q = custom.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q),
    );
  }, [options, custom]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={t("config.currentModel")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl border bg-card px-4 py-3.5 text-left shadow-xs transition-fast",
          current
            ? "border-primary/40 hover:border-primary/60"
            : "border-dashed border-border/50",
        )}
      >
        <span
          className={cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
            current ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          <Box className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] uppercase tracking-wider text-muted-foreground/70">
            {t("config.currentModel")}
          </span>
          {current ? (
            <span className="flex items-baseline gap-2">
              <span className="truncate text-sm font-semibold">{current.label}</span>
              {current.hint && (
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {current.hint}
                </span>
              )}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">{emptyHint ?? t("config.noModelConfigured")}</span>
          )}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {!current && emptyActionLabel && onEmptyAction && !open && (
        <button
          type="button"
          onClick={onEmptyAction}
          className="mt-2 w-full rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-fast hover:bg-primary/20"
        >
          {emptyActionLabel}
        </button>
      )}

      {open && (
        <div className="absolute left-0 top-[calc(100%+0.35rem)] z-50 max-h-72 w-full overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-xl">
          {allowCustom && (
            <input
              className="mb-1 w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs font-mono"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder={customPlaceholder ?? t("config.modelComboboxPlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && custom.trim()) {
                  onSelect(custom.trim());
                  setCustom("");
                  setOpen(false);
                }
              }}
            />
          )}
          {filtered.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {allowCustom ? t("config.activeModelCustomHint") : t("common.notFound")}
            </p>
          ) : (
            filtered.map((o) => {
              const active = current?.value === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                    active ? "bg-primary/10 text-primary" : "hover:bg-accent/50",
                  )}
                  onClick={() => {
                    onSelect(o.value);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{o.label}</span>
                    {o.hint && (
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {o.hint}
                      </span>
                    )}
                  </span>
                  {active && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
