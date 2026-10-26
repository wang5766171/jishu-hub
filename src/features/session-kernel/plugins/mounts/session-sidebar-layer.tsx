/**
 * SessionSidebarLayer —— 侧边栏面板宿主（v0.9.2 测试期：sidebar-panel
 * 挂载形态，用户裁决「支持悬浮窗，也支持侧边栏，按插件声明处理」）。
 *
 * 形态：挤压式布局——面板 fixed 于窗口右侧（同文件预览几何），主区由
 * app 层 ViewerPushRow 让位（margin 与面板宽度共用 session-sidebar 的
 * effectiveWidth，保证齐边）。左缘拖拽条调宽/双击复位（同文件预览交互）。
 * 与 SessionPanelLayer（悬浮停靠）平行；只渲染 sidebar-panel 声明的插件。
 */
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelRightClose } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  clampSidebarWidth,
  closeSessionSidebar,
  setSessionSidebarUserWidth,
  useSessionSidebar,
} from "../../shell/session-sidebar";
import { listSessionPlugins, useEnabledSessionPlugins } from "../registry";
import { sidebarPanelsOf } from "../types";
import type { SessionKernelContext } from "../types";

export function SessionSidebarLayer({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const enabled = useEnabledSessionPlugins();
  const sidebar = useSessionSidebar();
  const dragState = useRef<{ pointerId: number } | null>(null);
  const [, setDragging] = useState(false);

  const mount = (() => {
    if (!sidebar.openId) return null;
    const plugin = listSessionPlugins().find((p) => p.id === sidebar.openId);
    if (!plugin || !enabled.has(plugin.id)) return null;
    return { plugin, mount: sidebarPanelsOf(plugin)[0] ?? null };
  })();

  // 拖拽调宽：宽度 = 窗口右缘到光标（与文件预览同语义）；捕获在稳定容器，
  // pointercancel/丢失捕获即结束。
  const onResizeStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = { pointerId: e.pointerId };
    document.body.style.userSelect = "none";
    setDragging(true);
  }, []);
  const onResizeMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState.current || dragState.current.pointerId !== e.pointerId) return;
    setSessionSidebarUserWidth(clampSidebarWidth(window.innerWidth - e.clientX, window.innerWidth));
  }, []);
  const onResizeEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState.current || dragState.current.pointerId !== e.pointerId) return;
    dragState.current = null;
    document.body.style.userSelect = "";
    setDragging(false);
  }, []);

  if (!mount?.mount) return null;

  const Body = mount.mount.Component;
  return (
    <div
      className="fixed bottom-6 right-0 top-11 z-40 flex flex-col border-l border-border bg-[var(--color-card)] shadow-lg"
      style={{ width: sidebar.effectiveWidth ?? "50vw" }}
      data-sidebar-plugin={mount.plugin.id}
    >
      {/* 左缘拖拽条：拖动调宽，双击恢复默认（内容区一半）。 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("fileViewer.resizeHandle", "调整预览宽度")}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onDoubleClick={() => setSessionSidebarUserWidth(null)}
        className="absolute bottom-0 left-0 top-0 z-10 w-1.5 cursor-ew-resize hover:bg-primary/40 active:bg-primary/60"
      />
      <div
        className="flex h-[44px] shrink-0 items-center justify-between border-b border-border/30 px-4"
        style={{ background: "var(--color-layer-1)" }}
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {t(mount.mount.titleKey, mount.mount.titleFallback)}
        </span>
        <button
          type="button"
          title={t("sessionPanels.hide", "收起面板")}
          onClick={closeSessionSidebar}
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Body ctx={ctx} />
      </div>
    </div>
  );
}
