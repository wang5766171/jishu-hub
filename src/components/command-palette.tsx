/**
 * Ctrl+K 命令面板（v0.9.5 需求1（原需求26）5e）：搜索插件名快速执行动作。
 *
 * 数据源：可快捷执行的组合插件（面板展开 / 动作执行，plugin-quick-run）；
 * 模糊匹配（子串 + 拼音首字不可行——直接子串 + 关键词包含）。键盘导航
 * （↑↓ 选择、Enter 执行、Esc 关闭）。Esc 在输入框焦点时优先关闭面板。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LayoutDashboard, Zap, Search } from "lucide-react";
import i18n from "@/i18n";
import { listQuickActions, runPluginQuickAction } from "@/lib/plugin-quick-run";

interface PaletteItem {
  pluginId: string;
  name: string;
  kind: "panel" | "action";
  actionLabel?: string;
}

export function CommandPalette({ sessionId }: { sessionId: string | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PaletteItem[]>([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Ctrl+K 全局开合（keydown 捕获层——先于输入框默认行为）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // 打开时拉取插件清单并聚焦。
  useEffect(() => {
    if (!open) {
      setQuery("");
      setIndex(0);
      return;
    }
    void listQuickActions().then(setItems);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        it.pluginId.toLowerCase().includes(q) ||
        (it.actionLabel ?? "").toLowerCase().includes(q),
    );
  }, [items, query]);

  const run = useCallback(
    async (item: PaletteItem) => {
      setOpen(false);
      await runPluginQuickAction(item.pluginId, sessionId);
    },
    [sessionId],
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[index]) {
      e.preventDefault();
      void run(filtered[index]);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-start justify-center bg-black/30 pt-[18vh] backdrop-blur-[2px]" onClick={() => setOpen(false)}>
      <div
        className="w-[min(520px,92vw)] overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2.5">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder={i18n.t("commandPalette.searchPlaceholder", { defaultValue: "" })}
            className="h-6 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <kbd className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              {items.length === 0 ? i18n.t("commandPalette.empty", { defaultValue: "" }) : i18n.t("commandPalette.noMatch", { defaultValue: "" })}
            </div>
          )}
          {filtered.map((it, i) => (
            <button
              key={it.pluginId}
              type="button"
              onMouseEnter={() => setIndex(i)}
              onClick={() => void run(it)}
              className={
                "flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-xs " +
                (i === index ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-accent/50")
              }
            >
              {it.kind === "panel" ? (
                <LayoutDashboard className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Zap className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="font-medium">{it.name}</span>
              <span className="truncate font-mono text-[10px] text-muted-foreground/60">{it.pluginId}</span>
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                {it.kind === "panel" ? i18n.t("commandPalette.openPanel", { defaultValue: "" }) : it.actionLabel}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
