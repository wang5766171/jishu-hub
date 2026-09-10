import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LayoutGrid, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  EDGE_PANEL_WIDTH,
  FLOAT_MIN_H,
  FLOAT_MIN_W,
  clampFloatRect,
  loadLayout,
  panelLayoutOf,
  saveLayout,
  type DockSlot,
  type FloatRect,
  type SessionLayoutState,
} from "../../shell/dock-layout";
import { listSessionPlugins, useEnabledSessionPlugins } from "../registry";
import { dockPanelsOf } from "../types";
import type { SessionKernelContext } from "../types";

/**
 * 停靠面板宿主（v0.9.2 需求1）：五槽位 + 拖拽落位 + 浮动窗口移动/调大小。
 *
 * 交互规范（2026-09-10 用户裁决）：
 * - 面板默认**收起**，经「能力中心」按钮展开
 * - 非最大化窗口：点击面板外任意区域自动折叠（防遮挡）
 * - 最大化窗口：不自动折叠（不遮挡主内容）
 * - 面板背景比会话区深 1-2 色度（视觉界限清晰）
 * - 能力中心按钮替代竖排图标列（4 列网格弹出）
 * - 快捷键框架就位（描述符 shortcut 字段 + 全局监听，暂无默认绑定）
 */

const PANEL_DRAG_MIME = "application/x-jishu-panel";

interface PanelEntry {
  id: string;
  title: string;
  slot: DockSlot;
  hidden: boolean;
  floatRect?: FloatRect;
  Component: React.ComponentType<{ ctx: SessionKernelContext }>;
}

/** 检测窗口是否最大化（面积接近全屏）。 */
function isWindowMaximized(): boolean {
  return window.innerWidth * window.innerHeight >= screen.width * screen.height * 0.92;
}

export function SessionPanelLayer({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const enabled = useEnabledSessionPlugins();
  const [layout, setLayout] = useState<SessionLayoutState>(() => loadLayout());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hubOpen, setHubOpen] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  // ── 非最大化窗口：点击面板外部自动折叠 ──
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (isWindowMaximized()) return; // 最大化不折叠
      // 检查点击是否在面板或能力中心内部
      const target = e.target as HTMLElement;
      if (layerRef.current?.contains(target)) return;
      if (hubRef.current?.contains(target)) return;
      // 在面板外部 → 折叠所有可见面板
      setLayout((prev) => {
        const hasVisible = Object.values(prev.panels).some((p) => !p.hidden);
        if (!hasVisible) return prev;
        const next = { ...prev, panels: { ...prev.panels } };
        for (const [id, panel] of Object.entries(next.panels)) {
          if (!panel.hidden) {
            next.panels[id] = { ...panel, hidden: true };
          }
        }
        return next;
      });
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // ── 快捷键框架（声明制：描述符 shortcut 字段匹配 → 切换面板显隐）──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 收集所有启用插件的快捷键
      const shortcuts: Array<{ id: string; combo: string }> = [];
      for (const plugin of listSessionPlugins()) {
        if (!enabled.has(plugin.id)) continue;
        const desc = plugin as { shortcut?: string };
        if (desc.shortcut) {
          shortcuts.push({ id: plugin.id, combo: desc.shortcut });
        }
      }
      if (shortcuts.length === 0) return;
      // 构建当前按键组合
      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push("ctrl");
      if (e.shiftKey) parts.push("shift");
      if (e.altKey) parts.push("alt");
      parts.push(e.key.toLowerCase());
      const combo = parts.join("+");
      const match = shortcuts.find((s) => s.combo.toLowerCase() === combo);
      if (match) {
        e.preventDefault();
        setLayout((prev) => {
          const current = prev.panels[match.id] ?? { slot: "right", hidden: true };
          return {
            ...prev,
            panels: {
              ...prev.panels,
              [match.id]: { ...current, hidden: !current.hidden },
            },
          };
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);

  const panels = useMemo<PanelEntry[]>(() => {
    const entries: PanelEntry[] = [];
    for (const plugin of listSessionPlugins()) {
      if (!enabled.has(plugin.id)) continue;
      for (const mount of dockPanelsOf(plugin)) {
        const resolved = panelLayoutOf(layout, plugin.id, mount.defaultSlot);
        entries.push({
          id: plugin.id,
          title: t(mount.titleKey, mount.titleFallback),
          slot: resolved.slot,
          hidden: resolved.hidden,
          floatRect: resolved.floatRect,
          Component: mount.Component,
        });
      }
    }
    return entries;
  }, [enabled, layout, t]);

  const setPanelLayout = useCallback((id: string, next: Partial<PanelEntry>) => {
    setLayout((prev) => {
      const current = prev.panels[id] ?? { slot: "right" as DockSlot, hidden: true };
      const merged = { ...current, ...next } as PanelEntry & { slot: DockSlot; hidden: boolean };
      return {
        ...prev,
        panels: {
          ...prev.panels,
          [id]: { slot: merged.slot, hidden: merged.hidden, floatRect: merged.floatRect },
        },
      };
    });
  }, []);

  if (panels.length === 0) return null;

  const visiblePanels = panels.filter((panel) => !panel.hidden);

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-20">
      {visiblePanels.map((panel) => (
        <PanelFrame
          key={panel.id}
          panel={panel}
          ctx={ctx}
          onHide={() => setPanelLayout(panel.id, { hidden: true })}
          onDockDragStart={() => setDraggingId(panel.id)}
          onDockDragEnd={() => setDraggingId(null)}
          onMoveFloat={(rect) => setPanelLayout(panel.id, { floatRect: rect, slot: "float" })}
        />
      ))}

      {/* ── 能力中心（替代竖排图标列）── */}
      <div ref={hubRef} className="pointer-events-auto absolute right-2 top-2">
        <button
          type="button"
          title={t("sessionPanels.hub.title", "能力中心")}
          aria-label={t("sessionPanels.hub.title", "能力中心")}
          onClick={() => setHubOpen((v) => !v)}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 bg-background/90 shadow-sm backdrop-blur transition-colors",
            hubOpen || visiblePanels.length > 0
              ? "bg-primary/10 text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <LayoutGrid className="h-4 w-4" />
        </button>
        {hubOpen && (
          <div className="absolute right-0 top-10 w-72 rounded-xl border border-border/70 bg-popover/95 p-3 shadow-lg backdrop-blur">
            <div className="mb-2 text-[10px] font-medium text-muted-foreground">
              {t("sessionPanels.hub.title", "能力中心")}
            </div>
            <div className="grid grid-cols-4 gap-2">
              {panels.map((panel) => {
                const isHidden = panel.hidden;
                return (
                  <button
                    key={panel.id}
                    type="button"
                    title={panel.title}
                    onClick={() => {
                      setPanelLayout(panel.id, { hidden: !isHidden });
                      setHubOpen(false);
                    }}
                    className={cn(
                      "flex h-14 flex-col items-center justify-center gap-1 rounded-lg border px-1 py-1.5 text-center transition-colors",
                      isHidden
                        ? "border-border/40 text-muted-foreground hover:bg-accent/50"
                        : "border-primary/40 bg-primary/10 text-foreground",
                    )}
                  >
                    <span className="text-[10px] font-medium leading-tight">{panel.title}</span>
                    <span className={cn("h-1 w-1 rounded-full", isHidden ? "bg-muted-foreground/30" : "bg-primary")} />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── 拖拽落区 ── */}
      {draggingId && (
        <DropZoneOverlay
          onDrop={(slot, clientX, clientY) => {
            const rect: FloatRect | undefined =
              slot === "float" ? floatRectFromPoint(clientX, clientY) : undefined;
            setPanelLayout(draggingId, { slot, hidden: false, floatRect: rect });
            setDraggingId(null);
          }}
        />
      )}
    </div>
  );
}

function floatRectFromPoint(x: number, y: number): FloatRect {
  return clampFloatRect(
    { x: x - EDGE_PANEL_WIDTH / 2, y: y - 60, w: EDGE_PANEL_WIDTH, h: 420 },
    { w: window.innerWidth, h: window.innerHeight },
  );
}

function DropZoneOverlay({
  onDrop,
}: {
  onDrop: (slot: DockSlot, clientX: number, clientY: number) => void;
}) {
  const zones: Array<{ slot: DockSlot; className: string }> = [
    { slot: "left", className: "left-2 top-1/4 h-1/2 w-10 -translate-y-1/2" },
    { slot: "right", className: "right-2 top-1/4 h-1/2 w-10 -translate-y-1/2" },
    { slot: "top", className: "top-2 left-1/4 w-1/2 h-8" },
    { slot: "bottom", className: "bottom-2 left-1/4 w-1/2 h-8" },
    { slot: "float", className: "top-1/2 left-1/2 h-24 w-40 -translate-x-1/2 -translate-y-1/2" },
  ];
  return (
    <div className="pointer-events-auto absolute inset-0">
      {zones.map((zone) => (
        <div
          key={zone.slot}
          className={cn(
            "absolute rounded-lg border-2 border-dashed border-primary/50 bg-primary/5",
            zone.className,
          )}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onDrop(zone.slot, e.clientX, e.clientY);
          }}
        />
      ))}
    </div>
  );
}

function PanelFrame({
  panel,
  ctx,
  onHide,
  onDockDragStart,
  onDockDragEnd,
  onMoveFloat,
}: {
  panel: PanelEntry;
  ctx: SessionKernelContext;
  onHide: () => void;
  onDockDragStart: () => void;
  onDockDragEnd: () => void;
  onMoveFloat: (rect: FloatRect) => void;
}) {
  const { t } = useTranslation();
  const resizeState = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);
  const moveState = useRef<{ startX: number; startY: number; origin: FloatRect } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (resizeState.current) {
        const s = resizeState.current;
        onMoveFloat({
          x: panel.floatRect?.x ?? 0,
          y: panel.floatRect?.y ?? 0,
          w: Math.max(FLOAT_MIN_W, s.startW + (e.clientX - s.startX)),
          h: Math.max(FLOAT_MIN_H, s.startH + (e.clientY - s.startY)),
        });
      } else if (moveState.current) {
        const s = moveState.current;
        onMoveFloat(
          clampFloatRect(
            {
              x: s.origin.x + (e.clientX - s.startX),
              y: s.origin.y + (e.clientY - s.startY),
              w: s.origin.w,
              h: s.origin.h,
            },
            { w: window.innerWidth, h: window.innerHeight },
          ),
        );
      }
    };
    const onUp = () => {
      resizeState.current = null;
      moveState.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onMoveFloat, panel.floatRect?.x, panel.floatRect?.y]);

  const Body = panel.Component;
  // v0.9.2 用户裁决：面板背景比会话区深 1-2 色度（bg-[var(--color-layer-2)]
  // 比 conversation 的 --color-layer-0/--background 深一档）
  const frameClass =
    panel.slot === "float"
      ? "pointer-events-auto absolute flex flex-col rounded-xl border border-border/70 bg-[var(--color-layer-2)]/95 shadow-xl backdrop-blur"
      : panel.slot === "left"
        ? "pointer-events-auto absolute bottom-0 left-0 top-0 flex flex-col border-r border-border/60 bg-[var(--color-layer-2)]/95 backdrop-blur"
        : panel.slot === "right"
          ? "pointer-events-auto absolute bottom-0 right-0 top-0 flex flex-col border-l border-border/60 bg-[var(--color-layer-2)]/95 backdrop-blur"
          : panel.slot === "top"
            ? "pointer-events-auto absolute left-0 right-0 top-0 flex max-h-56 flex-col border-b border-border/60 bg-[var(--color-layer-2)]/95 backdrop-blur"
            : "pointer-events-auto absolute bottom-0 left-0 right-0 flex max-h-56 flex-col border-t border-border/60 bg-[var(--color-layer-2)]/95 backdrop-blur";
  const frameStyle: React.CSSProperties =
    panel.slot === "float"
      ? {
          left: panel.floatRect?.x ?? 80,
          top: panel.floatRect?.y ?? 80,
          width: panel.floatRect?.w ?? EDGE_PANEL_WIDTH,
          height: panel.floatRect?.h ?? 420,
          zIndex: 30,
        }
      : panel.slot === "left" || panel.slot === "right"
        ? { width: EDGE_PANEL_WIDTH }
        : {};

  return (
    <div className={frameClass} style={frameStyle} data-panel-id={panel.id} data-panel-slot={panel.slot}>
      <div
        className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-border/40 px-2.5"
        draggable={panel.slot !== "float"}
        onDragStart={(e) => {
          e.dataTransfer.setData(PANEL_DRAG_MIME, panel.id);
          e.dataTransfer.effectAllowed = "move";
          onDockDragStart();
        }}
        onDragEnd={onDockDragEnd}
        onMouseDown={(e) => {
          if (panel.slot === "float" && panel.floatRect) {
            moveState.current = {
              startX: e.clientX,
              startY: e.clientY,
              origin: panel.floatRect,
            };
          }
        }}
      >
        <span className="truncate text-xs font-medium text-foreground">{panel.title}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            title={t("sessionPanels.hide", "收起面板")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onHide}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <Body ctx={ctx} />
      </div>
      {panel.slot === "float" && (
        <div
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          onMouseDown={(e) => {
            e.stopPropagation();
            resizeState.current = {
              startX: e.clientX,
              startY: e.clientY,
              startW: panel.floatRect?.w ?? EDGE_PANEL_WIDTH,
              startH: panel.floatRect?.h ?? 420,
            };
          }}
        />
      )}
    </div>
  );
}
