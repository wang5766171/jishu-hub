import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelRightClose, Pin, X } from "lucide-react";
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
 * 停靠面板宿主（v0.9.2 需求1 P2/P3）：五槽位（左/右/顶/底/浮动）+ 拖拽
 * 落位 + 浮动窗口移动/调大小 + 快捷图标显隐。宿主为通用容器，无任何插件
 * 专属逻辑——M3「任务流程全景」是首个真实面板。
 *
 * 挂载位置：会话主区根容器内（父需 position:relative）；无已显示面板时
 * 零渲染（pointer-events 不阻挡消息区）。
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

export function SessionPanelLayer({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const enabled = useEnabledSessionPlugins();
  const [layout, setLayout] = useState<SessionLayoutState>(() => loadLayout());
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

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

  const visiblePanels = panels.filter((panel) => !panel.hidden);
  const hiddenToggleable = panels.length > 0;

  const setPanelLayout = useCallback((id: string, next: Partial<PanelEntry>) => {
    setLayout((prev) => {
      const current = prev.panels[id] ?? { slot: "right" as DockSlot, hidden: false };
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

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
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

      {hiddenToggleable && (
        <div className="pointer-events-auto absolute right-2 top-2 flex flex-col gap-1">
          {panels.map((panel) => (
            <button
              key={panel.id}
              type="button"
              title={panel.title}
              aria-label={panel.title}
              onClick={() => setPanelLayout(panel.id, { hidden: !panel.hidden })}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground",
                !panel.hidden && "bg-primary/10 text-foreground",
              )}
            >
              <span className="text-[11px] font-semibold">{panel.title.slice(0, 1)}</span>
            </button>
          ))}
        </div>
      )}

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
  const frameClass =
    panel.slot === "float"
      ? "pointer-events-auto absolute flex flex-col rounded-xl border border-border/70 bg-background/95 shadow-xl backdrop-blur"
      : panel.slot === "left"
        ? "pointer-events-auto absolute bottom-0 left-0 top-0 flex flex-col border-r border-border/60 bg-background/95 backdrop-blur"
        : panel.slot === "right"
          ? "pointer-events-auto absolute bottom-0 right-0 top-0 flex flex-col border-l border-border/60 bg-background/95 backdrop-blur"
          : panel.slot === "top"
            ? "pointer-events-auto absolute left-0 right-0 top-0 flex max-h-56 flex-col border-b border-border/60 bg-background/95 backdrop-blur"
            : "pointer-events-auto absolute bottom-0 left-0 right-0 flex max-h-56 flex-col border-t border-border/60 bg-background/95 backdrop-blur";
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
          {panel.slot === "float" && (
            <button
              type="button"
              title={t("sessionPanels.dock", "停靠到右侧")}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onHide /* 由父层把 float 收回隐藏，快捷图标恢复 */}
              // float 的重新停靠经快捷图标 + 拖拽完成；此按钮语义为关闭浮窗
            >
              <Pin className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            title={t("sessionPanels.hide", "收起面板")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onHide}
          >
            {panel.slot === "top" || panel.slot === "bottom" ? (
              <PanelRightClose className="h-3.5 w-3.5" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}
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
