import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Bug, Copy, Eraser, Pause, Play, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  clearDevLogs,
  devLogVersion,
  formatDevLogs,
  getDevLogs,
  subscribeDevLogs,
  type DevLogCategory,
} from "@/lib/dev-log";

/**
 * v0.9.4 需求12：dev 日志中心（仅 dev 渲染——挂载点 session-panel-layer 条件
 * 引入）。全流程会话流转/时序排查：事件管线、流式 store、steer 协调器、IPC、
 * 会话切换/滚动。内容可复制（粘贴给 agent 快速定位问题）。
 */

const CATEGORY_COLOR: Record<DevLogCategory, string> = {
  pipeline: "text-sky-600 dark:text-sky-400",
  store: "text-emerald-600 dark:text-emerald-400",
  steer: "text-amber-600 dark:text-amber-500",
  ipc: "text-violet-600 dark:text-violet-400",
  session: "text-rose-600 dark:text-rose-400",
  approval: "text-cyan-600 dark:text-cyan-400",
  plugin: "text-fuchsia-600 dark:text-fuchsia-400",
};
const CATEGORIES = Object.keys(CATEGORY_COLOR) as DevLogCategory[];

export const DevLogCenter = memo(function DevLogCenter() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<Set<DevLogCategory>>(new Set(CATEGORIES));
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useSyncExternalStore(subscribeDevLogs, devLogVersion, devLogVersion);
  const entries = getDevLogs();
  const t0 = entries[0]?.ts ?? 0;
  // v0.9.4 需求12（用户实测：不重新进入不刷新）：entries 是模块可变数组，
  // push 不换引用 → useMemo([entries]) 永不失效。改为每渲染直接过滤
  //（≤3000 条 filter 代价可忽略），version 变化（useSyncExternalStore）触发
  // 重渲染即得新列表——tail -f 实时效果。
  const filtered = entries.filter((e) => enabled.has(e.category));

  useEffect(() => {
    if (open && autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filtered.length, open, autoScroll]);

  const copyAll = async () => {
    const text = formatDevLogs([...enabled]);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard 不可用时回退选区复制提示
      console.warn("[dev-log] clipboard write failed; text length:", text.length);
    }
  };

  const toggleCategory = (c: DevLogCategory) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  return (
    <>
      {/* 悬浮入口：能力中心按钮下方 */}
      <div className="pointer-events-auto absolute right-2 top-12">
        <button
          type="button"
          title={t("devLog.openTitle", { defaultValue: "开发日志中心" })}
          aria-label={t("devLog.openTitle", { defaultValue: "开发日志中心" })}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 bg-background/90 shadow-sm backdrop-blur transition-colors",
            open ? "border-primary/50 bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Bug className="h-4 w-4" />
        </button>
      </div>

      {open && (
        <div className="pointer-events-auto absolute inset-4 z-50 flex flex-col rounded-2xl border border-border/70 bg-background/97 shadow-2xl backdrop-blur">
          {/* 工具栏 */}
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
            <span className="text-xs font-semibold text-foreground">
              {t("devLog.title", { defaultValue: "开发日志中心" })}
              <span className="ml-2 font-normal text-muted-foreground">
                {filtered.length}/{entries.length}
              </span>
            </span>
            <div className="ml-2 flex flex-wrap items-center gap-1">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleCategory(c)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
                    enabled.has(c)
                      ? cn("border-border/60 bg-muted/40", CATEGORY_COLOR[c])
                      : "border-border/30 text-muted-foreground/40",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                title={autoScroll ? t("devLog.pauseScroll") : t("devLog.resumeScroll")}
                onClick={() => setAutoScroll((v) => !v)}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {autoScroll ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                title={t("devLog.clear")}
                onClick={() => clearDevLogs()}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Eraser className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={copyAll}
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted"
              >
                <Copy className="h-3 w-3" />
                {copied ? t("devLog.copied", { defaultValue: "已复制" }) : t("devLog.copy", { defaultValue: "复制日志" })}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          {/* 日志列表 */}
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5">
            {filtered.length === 0 && (
              <div className="py-8 text-center text-muted-foreground">
                {t("devLog.empty", { defaultValue: "暂无日志（操作会话后产生）" })}
              </div>
            )}
            {filtered.map((e) => (
              <div key={e.seq} className="flex items-baseline gap-2 whitespace-pre-wrap break-all">
                <span className="shrink-0 text-muted-foreground/60">#{e.seq}</span>
                <span className="shrink-0 text-muted-foreground/70">+{(e.ts - t0)}ms</span>
                <span className={cn("shrink-0 font-semibold", CATEGORY_COLOR[e.category])}>[{e.category}]</span>
                <span className="text-foreground/90">{e.message}</span>
                {e.data !== undefined && (
                  <span className="text-muted-foreground/70">{JSON.stringify(e.data)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
});
