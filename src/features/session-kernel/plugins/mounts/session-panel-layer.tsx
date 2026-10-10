import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DevLogCenter } from "@/components/dev/dev-log-center";
import { isDevLogForced } from "@/lib/dev-log";
import { useTranslation } from "react-i18next";
import { getCurrentWindow as tauriGetCurrentWindow } from "@tauri-apps/api/window";
import { ChartPie, LayoutGrid, ListTodo, Map, Minimize2, Package, Search } from "lucide-react";
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
import {
  closeSessionSidebar,
  openSessionSidebar,
  useSessionSidebar,
} from "../../shell/session-sidebar";
import { usePanelActivation } from "../../shell/panel-activation";
// 批次5：能力中心常驻挂件定位（复用 5a spotlight 脉冲）与管理页导航。
import { requestInstallSpotlight } from "../../shell/install-spotlight";
import { openManagePage } from "@/lib/app-nav";
import { useAllPluginBehaviors } from "../config-plane";
import { listSessionPlugins, useEnabledSessionPlugins } from "../registry";
import { dockPanelsOf, sidebarPanelsOf, railWidgetsOf, composerTrailingsOf } from "../types";
import type { SessionKernelContext } from "../types";

/**
 * 停靠面板宿主（v0.9.2 需求1）：五槽位 + 拖拽 + 浮动窗口。
 *
 * 交互规范（2026-09-10 用户裁决，二轮调整；2026-09-11 三轮调整）：
 * - **单选模式**：同一时间只展开一个面板，点另一个 = 切换（先收旧再展新）
 * - 能力中心按钮图标 = **当前展开的插件图标**（无展开时显示 LayoutGrid）
 * - 能力中心按钮点击顺序：**有面板展开 → 收起该面板（图标复位 LayoutGrid）**；
 *   无面板展开 → 弹出能力列表（再点关闭列表）。此前无论何种状态都弹列表，
 *   导致"选了任务看板后再点图标"无法收起看板（用户 2026-09-11 反馈）
 * - 面板卡片：图标在上、名称在下（任务看板/用量看板/搜索看板）
 * - 点击面板外自动折叠当前面板 + 关闭能力列表（非最大化窗口限定面板折叠）
 * - 快捷键框架（描述符 shortcut 字段，暂无默认绑定）
 */

const PANEL_DRAG_MIME = "application/x-jishu-panel";

interface PanelEntry {
  id: string;
  title: string;
  slot: DockSlot;
  hidden: boolean;
  /** 需求13 二轮：活动功能的胶囊态（仅 float 悬浮窗缩小时）。 */
  collapsed?: boolean;
  floatRect?: FloatRect;
  Component: React.ComponentType<{ ctx: SessionKernelContext }>;
  /** 需求13 三轮：胶囊信息缩略渲染（缺省 fallback 图标+标题）。 */
  CapsuleComponent?: React.ComponentType<{ ctx: SessionKernelContext }>;
}

/** 插件图标映射（按插件 id → lucide 图标组件）。 */
const PLUGIN_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "session.task-board": Map,
  "session.todo-board": ListTodo,
  "session.usage": ChartPie,
  "session.search": Search,
  "session.artifacts": Package,
};

function isWindowMaximized(): boolean {
  return window.innerWidth * window.innerHeight >= screen.width * screen.height * 0.92;
}

export function SessionPanelLayer({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const enabled = useEnabledSessionPlugins();
  // 批次4：使用行为键（管理面设置 tab 驱动，保存热生效）：默认归所/
  // 自动展开策略/作用域。
  const behaviors = useAllPluginBehaviors();
  const inTaskSession = ctx.task != null;
  const [layout, setLayout] = useState<SessionLayoutState>(() => loadLayout());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hubOpen, setHubOpen] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  // v0.9.5 需求12（2026-10-10 改版）：最近展开的面板 id——进入全屏时自动
  // 展开（用户裁决「全屏的时候自动展开」）；仅记忆本会话内使用过的面板，
  // 无记忆不动（不硬编码任何插件）。
  const lastOpenedRef = useRef<string | null>(null);
  // showPanel 稳定转发（全屏 effect 先于 showPanel 定义引用）。
  const showPanelStableRef = useRef<(id: string) => void>(() => {});

  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  // 需求12：全屏自动展开——Tauri 窗口进入全屏（onResized→isFullscreen）
  // 展开最近使用的面板；退出全屏不强制收起（用户自己控制）。浏览器环境
  // 守卫同 app.tsx 惯例。
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let lastFullscreen = false;
    const win = tauriGetCurrentWindow();
    const sync = async () => {
      try {
        const fs = await win.isFullscreen();
        if (disposed || fs === lastFullscreen) return;
        lastFullscreen = fs;
        if (fs && lastOpenedRef.current) {
          showPanelStableRef.current(lastOpenedRef.current);
        }
      } catch {
        /* IPC 失败静默 */
      }
    };
    void sync();
    const unlisten = win.onResized(() => void sync());
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
    };
  }, []);

  // ── 单选切换：展开一个时收起其他 ──
  const showPanel = useCallback((id: string) => {
    lastOpenedRef.current = id;
    setLayout((prev) => {
      const next = { ...prev, panels: { ...prev.panels } };
      // 先收起所有（需求13 二轮：清除胶囊态——切换活动功能时旧的连同胶囊隐藏）
      for (const [pid, panel] of Object.entries(next.panels)) {
        if (!panel.hidden || panel.collapsed) {
          next.panels[pid] = { ...panel, hidden: true, collapsed: false };
        }
      }
      // 再展开目标（或如果原本就是唯一展开的 → 切换关闭）
      const wasSoleVisible =
        !prev.panels[id]?.hidden &&
        Object.values(prev.panels).filter((p) => !p.hidden).length === 1;
      if (!wasSoleVisible) {
        const current = next.panels[id] ?? { slot: "right" as DockSlot, hidden: true };
        next.panels[id] = { ...current, hidden: false, collapsed: false };
      }
      return next;
    });
  }, []);

  // 需求12：每渲染刷新稳定转发（全屏自动展开经此调用最新 showPanel）。
  showPanelStableRef.current = showPanel;

  /** 需求13 二轮：缩小为胶囊——活动功能保留胶囊态（hidden+collapsed）；
   * 仅 float 悬浮窗缩小为胶囊，停靠槽收起维持原 hidden 语义（无胶囊）。 */
  const collapsePanel = useCallback((id: string) => {
    setLayout((prev) => {
      const target = prev.panels[id];
      if (!target || target.slot !== "float") {
        // 停靠槽：维持原单选切换（再次 showPanel 切换关闭）
        return prev;
      }
      return {
        ...prev,
        panels: { ...prev.panels, [id]: { ...target, hidden: true, collapsed: true } },
      };
    });
  }, []);

  // ── 点击面板外部：关闭能力列表（任意窗口形态）；非最大化窗口同时折叠当前面板 ──
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (hubRef.current?.contains(target)) return;
      setHubOpen(false);
      if (isWindowMaximized()) return;
      if (layerRef.current?.contains(target)) return;
      setLayout((prev) => {
        // 需求13：float 悬浮窗常驻（缩小为胶囊由用户手动控制），点击外部
        // 只折叠停靠槽（left/right/top/bottom）面板。
        const hasVisible = Object.values(prev.panels).some((p) => !p.hidden && p.slot !== "float");
        if (!hasVisible) return prev;
        const next = { ...prev, panels: { ...prev.panels } };
        for (const [id, panel] of Object.entries(next.panels)) {
          if (!panel.hidden && panel.slot !== "float") {
            next.panels[id] = { ...panel, hidden: true };
          }
        }
        return next;
      });
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // ── 快捷键框架（差异性完善：行为键 ui.shortcut 优先于描述符声明）──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const shortcuts: Array<{ id: string; combo: string }> = [];
      for (const plugin of listSessionPlugins()) {
        if (!enabled.has(plugin.id)) continue;
        const desc = plugin as { shortcut?: string };
        const combo = behaviors[plugin.id]?.shortcut ?? desc.shortcut;
        if (combo) {
          shortcuts.push({ id: plugin.id, combo });
        }
      }
      if (shortcuts.length === 0) return;
      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push("ctrl");
      if (e.shiftKey) parts.push("shift");
      if (e.altKey) parts.push("alt");
      parts.push(e.key.toLowerCase());
      const combo = parts.join("+");
      const match = shortcuts.find((s) => s.combo.toLowerCase() === combo);
      if (match) {
        e.preventDefault();
        showPanel(match.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, showPanel]);

  const panels = useMemo<PanelEntry[]>(() => {
    const entries: PanelEntry[] = [];
    for (const plugin of listSessionPlugins()) {
      if (!enabled.has(plugin.id)) continue;
      // 批次4：作用域过滤（task-only 仅任务会话呈现）。
      const bhv = behaviors[plugin.id];
      if (bhv?.scope === "task-only" && !inTaskSession) continue;
      for (const mount of dockPanelsOf(plugin)) {
        // 批次4：行为键归所——sidebar 归所的面板交侧栏层渲染（不进悬浮列表）；
        // left/right 覆盖声明槽位（仅无布局记忆时生效——panelLayoutOf 内
        // state.panels 命中分支记忆优先）。
        if (bhv?.defaultSlot === "sidebar") continue;
        const declared =
          bhv?.defaultSlot === "left" || bhv?.defaultSlot === "right" ? bhv.defaultSlot : mount.defaultSlot;
        const resolved = panelLayoutOf(layout, plugin.id, declared);
        entries.push({
          id: plugin.id,
          title: t(mount.titleKey, mount.titleFallback),
          slot: resolved.slot,
          hidden: resolved.hidden,
          collapsed: (layout.panels[plugin.id] as { collapsed?: boolean } | undefined)?.collapsed,
          floatRect: resolved.floatRect,
          Component: mount.Component,
          CapsuleComponent: mount.CapsuleComponent,
        });
      }
    }
    return entries;
  }, [enabled, layout, t, behaviors, inTaskSession]);

  // ── 侧边栏形态插件（v0.9.2 测试期：能力中心统一调度悬浮/侧栏两形态）──
  const sidebarEntries = useMemo(() => {
    const entries: Array<{ id: string; title: string }> = [];
    for (const plugin of listSessionPlugins()) {
      if (!enabled.has(plugin.id)) continue;
      const bhv = behaviors[plugin.id];
      if (bhv?.scope === "task-only" && !inTaskSession) continue;
      for (const mount of sidebarPanelsOf(plugin)) {
        entries.push({ id: plugin.id, title: t(mount.titleKey, mount.titleFallback) });
      }
    }
    return entries;
  }, [enabled, t, behaviors, inTaskSession]);
  const sidebarOpenId = useSessionSidebar().openId;
  // 批次4：行为键「右侧栏」归所的面板按侧栏形态调度（能力中心/激活路由）。
  const isSidebarPlugin = useCallback(
    (id: string) =>
      sidebarEntries.some((entry) => entry.id === id) || behaviors[id]?.defaultSlot === "sidebar",
    [sidebarEntries, behaviors],
  );

  // 批次5：常驻挂件清单（rail/composer/**动作位**，作用域同口径）——能力中心
  // 第二组仅定位（点击 spotlight 脉冲）；启停归插件中心/挂件右键（双开关口径铁律）。
  const residentEntries = useMemo(() => {
    const entries: Array<{ id: string; title: string }> = [];
    for (const plugin of listSessionPlugins()) {
      if (!enabled.has(plugin.id)) continue;
      const bhv = behaviors[plugin.id];
      if (bhv?.scope === "task-only" && !inTaskSession) continue;
      if (
        railWidgetsOf(plugin).length ||
        composerTrailingsOf(plugin).length ||
        plugin.mounts.some((m) => m.kind === "header-action")
      ) {
        entries.push({ id: plugin.id, title: t(plugin.displayNameKey, plugin.displayNameFallback) });
      }
    }
    return entries;
  }, [enabled, t, behaviors, inTaskSession]);

  const hideAllDockPanels = useCallback(() => {
    setLayout((prev) => {
      const hasVisible = Object.values(prev.panels).some((p) => !p.hidden);
      if (!hasVisible) return prev;
      const next = { ...prev, panels: { ...prev.panels } };
      for (const [pid, panel] of Object.entries(next.panels)) {
        if (!panel.hidden) next.panels[pid] = { ...panel, hidden: true };
      }
      return next;
    });
  }, []);

  // 统一激活（单选互斥）：侧栏插件 → 收起悬浮 + 展开侧栏；悬浮插件 →
  // 收侧栏 + showPanel（其内部含单选与再点关闭语义）。
  const activatePanel = useCallback(
    (id: string) => {
      if (isSidebarPlugin(id)) {
        hideAllDockPanels();
        if (sidebarOpenId !== id) openSessionSidebar(id);
      } else {
        closeSessionSidebar();
        showPanel(id);
      }
    },
    [isSidebarPlugin, sidebarOpenId, hideAllDockPanels, showPanel],
  );

  // ctx.openPanel/closePanel 落点：插件请求展开/收起面板 → 按形态生效。
  const activation = usePanelActivation();
  useEffect(() => {
    if (!activation) return;
    if (activation.pluginId === "__close__") {
      closeSessionSidebar();
      hideAllDockPanels();
      return;
    }
    if (isSidebarPlugin(activation.pluginId)) {
      hideAllDockPanels();
      openSessionSidebar(activation.pluginId);
    } else {
      closeSessionSidebar();
      showPanel(activation.pluginId);
    }
    // seq 驱动：同一插件重复请求（连续预览刷新）也重新激活。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activation?.seq]);

  // 批次4：autoOpen=every-session——进入新会话（含首次挂载）自动展开首个
  // 命中面板（单选互斥取一）；never/install-once（默认）不在此动作——
  // install-once 由 5a 确认卡链路承担。仅会话切换驱动（行为保存不重开）。
  const autoOpenSession = ctx.sessionId;
  useEffect(() => {
    if (!autoOpenSession) return;
    for (const plugin of listSessionPlugins()) {
      if (!enabled.has(plugin.id)) continue;
      const bhv = behaviors[plugin.id];
      if (bhv?.autoOpen !== "every-session") continue;
      if (!dockPanelsOf(plugin).length && !sidebarPanelsOf(plugin).length) continue;
      if (bhv.scope === "task-only" && ctx.task == null) continue;
      if (isSidebarPlugin(plugin.id)) {
        hideAllDockPanels();
        if (sidebarOpenId !== plugin.id) openSessionSidebar(plugin.id);
      } else {
        closeSessionSidebar();
        showPanel(plugin.id);
      }
      break;
    }
    // 依赖仅会话 id：切换会话触发；behaviors/enabled 快照取当次值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenSession]);

  const hasAnyMount = panels.length > 0 || sidebarEntries.length > 0;
  if (!hasAnyMount) return null;

  const visiblePanels = panels.filter((panel) => !panel.hidden);
  // 需求13 二轮：胶囊仅限「点开后缩小」的活动功能（collapsed 标记）——
  // 未点开的不悬浮在外（能力中心是唯一入口）；切换活动功能时胶囊随单选清除。
  const collapsedPanels = panels.filter((panel) => panel.hidden && panel.collapsed);
  const activePanel = visiblePanels[0] ?? null;
  // 活动插件 = 悬浮面板或侧栏面板（图标/点击收起规则统一覆盖两形态）。
  const activePluginId = activePanel?.id ?? sidebarOpenId;
  const activeTitle =
    activePanel?.title ?? sidebarEntries.find((e) => e.id === sidebarOpenId)?.title ?? null;
  const ActiveIcon = activePluginId ? PLUGIN_ICONS[activePluginId] ?? LayoutGrid : LayoutGrid;

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-20">
      {visiblePanels.map((panel) => (
        <PanelFrame
          key={panel.id}
          panel={panel}
          ctx={ctx}
          onHide={() => collapsePanel(panel.id)}
          onDockDragStart={() => setDraggingId(panel.id)}
          onDockDragEnd={() => setDraggingId(null)}
          onMoveFloat={(rect) => {
            setLayout((prev) => ({
              ...prev,
              panels: {
                ...prev.panels,
                [panel.id]: { ...(prev.panels[panel.id] ?? { slot: "float", hidden: false }), slot: "float", floatRect: rect },
              },
            }));
          }}
        />
      ))}

      {/* v0.9.4 需求12：dev 日志中心——dev 构建恒启用；生产构建默认剔除
          （import.meta.env.DEV 静态 false），强制开关（isDevLogForced，
          settings.json 持久化）可开（安装包排查场景）。 */}
      {(import.meta.env.DEV || isDevLogForced()) && <DevLogCenter />}

      {/* ── 能力中心按钮（图标 = 当前展开插件）+ 左侧并排胶囊（需求13 三轮：
          胶囊在左/按钮在右/中间间隔 gap-2；胶囊 = 活动功能的信息缩略）── */}
      <div ref={hubRef} className="pointer-events-auto absolute right-2 top-2 flex items-center gap-2">
        {collapsedPanels.map((panel) => {
          const Capsule = panel.CapsuleComponent;
          return (
            <button
              key={panel.id}
              type="button"
              title={t("sessionPanels.expand", "展开悬浮窗") + " · " + panel.title}
              className="flex h-8 max-w-44 items-center gap-1.5 rounded-full border border-border/70 bg-[var(--color-layer-2)] px-3 shadow-md backdrop-blur transition-colors hover:border-primary/50"
              onClick={() => showPanel(panel.id)}
            >
              {Capsule ? <Capsule ctx={ctx} /> : (
                <>
                  <span className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-[11px] font-medium text-foreground/90">{panel.title}</span>
                </>
              )}
            </button>
          );
        })}
        <button
          type="button"
          title={activeTitle ?? t("sessionPanels.hub.title", "能力中心")}
          aria-label={t("sessionPanels.hub.title", "能力中心")}
          onClick={() => {
            // 2026-09-11 三轮调整：有面板展开时点击 = 收起面板（图标复位能力
            // 中心）；无面板展开时才弹出/关闭能力列表。2026-09-12：统一覆盖
            // 悬浮/侧栏两形态。
            if (activePluginId) {
              if (sidebarOpenId && !activePanel) closeSessionSidebar();
              else if (activePanel) showPanel(activePanel.id);
              setHubOpen(false);
            } else {
              setHubOpen((v) => !v);
            }
          }}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 bg-background/90 shadow-sm backdrop-blur transition-colors",
            activePluginId
              ? "border-primary/40 bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <ActiveIcon className="h-4 w-4" />
        </button>

        {hubOpen && (
          <div className="absolute right-0 top-10 w-60 rounded-xl border border-border/70 bg-popover/95 p-3 shadow-lg backdrop-blur">
            <div className="mb-1 text-[9px] font-medium text-muted-foreground">
              {t("sessionPanels.hub.title", "能力中心")}
            </div>
            {/* 批次5：分组呈现——面板可调度（点击 toggle）；常驻挂件仅定位
                （点击闪烁提示位置；启停归插件中心/右键菜单，双开关口径铁律）。 */}
            <div className="mb-1 text-[9px] text-muted-foreground/70">
              {t("sessionPanels.hub.groupPanels", "面板 · 点击调度")}
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {[...panels, ...sidebarEntries].map((entry) => {
                const Icon = PLUGIN_ICONS[entry.id] ?? LayoutGrid;
                const isActive = !("hidden" in entry) ? sidebarOpenId === entry.id : !(entry as { hidden: boolean }).hidden;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    title={entry.title}
                    onClick={() => {
                      activatePanel(entry.id);
                      setHubOpen(false);
                    }}
                    className={cn(
                      "flex h-14 flex-col items-center justify-center gap-1 rounded-lg border px-0.5 transition-colors",
                      isActive
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border/40 text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span className="text-[9px] font-medium leading-tight whitespace-nowrap">{entry.title}</span>
                  </button>
                );
              })}
            </div>
            {residentEntries.length > 0 ? (
              <>
                <div className="mb-1 mt-2.5 text-[9px] text-muted-foreground/70">
                  {t("sessionPanels.hub.groupResidents", "常驻挂件 · 点击定位")}
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {residentEntries.map((entry) => {
                    const Icon = PLUGIN_ICONS[entry.id] ?? LayoutGrid;
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        title={t("sessionPanels.hub.locateHint", "{{name}}（常驻——点击高亮定位；右键挂件可停用/设置）", { name: entry.title })}
                        onClick={() => {
                          requestInstallSpotlight(entry.id);
                          setHubOpen(false);
                        }}
                        className="flex h-14 flex-col items-center justify-center gap-1 rounded-lg border border-border/40 px-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                      >
                        <Icon className="h-3.5 w-3.5" />
                        <span className="text-[9px] font-medium leading-tight whitespace-nowrap">{entry.title}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
            {/* 批次5：底部管理入口（管理面唯一开关口径的导航闭环）。 */}
            <div className="mt-2.5 flex items-center justify-between border-t border-border/50 pt-2">
              <span className="text-[9px] text-muted-foreground/60">
                {panels.length + sidebarEntries.length} {t("sessionPanels.hub.panelCount", "面板")} · {residentEntries.length} {t("sessionPanels.hub.widgetCount", "挂件")}
              </span>
              <button
                type="button"
                className="text-[10px] text-primary/90 transition-colors hover:text-primary"
                onClick={() => {
                  setHubOpen(false);
                  openManagePage("plugins");
                }}
              >
                {t("sessionPanels.hub.manage", "管理插件…")} →
              </button>
            </div>
          </div>
        )}
      </div>

      {draggingId && (
        <DropZoneOverlay
          onDrop={(slot, clientX, clientY) => {
            const rect: FloatRect | undefined =
              slot === "float" ? floatRectFromPoint(clientX, clientY) : undefined;
            setLayout((prev) => ({
              ...prev,
              panels: {
                ...prev.panels,
                [draggingId]: {
                  ...(prev.panels[draggingId] ?? { slot, hidden: false }),
                  slot,
                  hidden: false,
                  floatRect: rect,
                },
              },
            }));
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
      ? "pointer-events-auto absolute flex flex-col rounded-xl border border-border bg-[var(--color-layer-2)] shadow-2xl ring-1 ring-black/10 backdrop-blur" /* 需求13 三轮：边缘区分度（实边框+ring+双层阴影，zcode 参考） */
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
          // 需求13：默认悬浮位 = 右侧留边不贴紧（20px）、约半高（上下各留
          // 1/4），超出内容纵向滚动（内容容器 overflow-auto）。
          left:
            panel.floatRect?.x ??
            Math.max(120, window.innerWidth - EDGE_PANEL_WIDTH - 24),
          top: panel.floatRect?.y ?? Math.round(window.innerHeight * 0.12),
          width: panel.floatRect?.w ?? EDGE_PANEL_WIDTH,
          // 需求13 四轮：高度内容自适应（zcode 口径——内容多高窗多高，不
          // 顶头）；仅用户手动调过大小（floatRect.h 有值）才固定，否则只
          // 设上限（约 70% 视口）超出内部滚动。
          ...(panel.floatRect?.h
            ? { height: panel.floatRect.h }
            : { maxHeight: Math.round(window.innerHeight * 0.7) }),
          zIndex: 30,
        }
      : panel.slot === "left" || panel.slot === "right"
        ? { width: EDGE_PANEL_WIDTH, zIndex: 20 }
        : {};

  return (
    <div className={frameClass} style={frameStyle} data-panel-id={panel.id} data-panel-slot={panel.slot}>
      <div
        className="flex h-9 shrink-0 cursor-grab items-center gap-2 rounded-t-xl border-b border-border/40 px-2.5 shadow-[0_1px_3px_rgba(0,0,0,0.08)]" /* 需求13：标题栏阴影分割 */
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
            title={t("sessionPanels.collapse", "缩小为胶囊")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onHide}
          >
            <Minimize2 className="h-3.5 w-3.5" />
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
