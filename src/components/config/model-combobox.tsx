// v0.7.4 需求2 R2a：可编辑模型下拉（combobox）。
// 推荐目录 + 当前值置顶 + 自由输入兜底——解决旧 select 硬编码 3 项、
// 新模型选不到的问题（01 分析 C1/C2）。

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  /** 展示名（已本地化）；缺省直接显示 value */
  label?: string;
}

export function ModelCombobox({
  id,
  value,
  onChange,
  options,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // 当前值不在目录时置顶显示，避免"选了但看不见"
  const withCurrent = useMemo(() => {
    const trimmed = value.trim();
    if (trimmed && !options.some((o) => o.value === trimmed)) {
      return [{ value: trimmed, label: trimmed }, ...options];
    }
    return options;
  }, [options, value]);

  const filtered = useMemo(() => {
    const q = (query ?? "").trim().toLowerCase();
    if (!q) return withCurrent;
    return withCurrent.filter(
      (o) =>
        o.value.toLowerCase().includes(q) ||
        (o.label ?? "").toLowerCase().includes(q),
    );
  }, [withCurrent, query]);

  return (
    <div ref={rootRef} className="relative">
      <div className="flex">
        <input
          id={id}
          className="flex h-9 w-full rounded-l-md border border-input bg-transparent px-3 py-1 text-sm font-mono shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={query ?? value}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
        />
        <button
          type="button"
          className="inline-flex h-9 items-center rounded-r-md border border-l-0 border-input px-2 text-muted-foreground hover:bg-muted/50"
          onClick={() => {
            setQuery(null);
            setOpen((v) => !v);
          }}
          aria-label={t("config.modelComboboxToggle")}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
      {open && filtered.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
          {filtered.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs",
                  o.value === value
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-muted",
                )}
                onClick={() => {
                  onChange(o.value);
                  setQuery(null);
                  setOpen(false);
                }}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-mono">{o.value}</span>
                  {o.label && o.label !== o.value && (
                    <span className="truncate text-[10px] text-muted-foreground">
                      {o.label}
                    </span>
                  )}
                </span>
                {o.value === value && <Check className="h-3 w-3 shrink-0" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
