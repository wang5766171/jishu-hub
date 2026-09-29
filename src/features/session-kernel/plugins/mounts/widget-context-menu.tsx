/**
 * 挂件右键菜单（v0.9.5 需求1 GUI 改造 · 批次5）：rail-widget /
 * composer-trailing 常驻挂件的统一管理入口——「停用插件」（热生效）与
 * 「在插件中心设置…」（导航事件，app-nav）。
 *
 * 形态：hook 返回 openFor（挂到宿主 onContextMenu）+ node（菜单浮层，
 * 点击外部/Esc 关闭）——与 install-spotlight 同款轻量模式。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invokeCommand } from "@/hooks/use-invoke";
import { openManagePage } from "@/lib/app-nav";

interface WidgetMenuTarget {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface WidgetContextMenu {
  openFor: (
    id: string,
    name: string,
    e: { preventDefault(): void; clientX: number; clientY: number },
  ) => void;
  node: ReactNode;
}

export function useWidgetContextMenu(): WidgetContextMenu {
  const [menu, setMenu] = useState<WidgetMenuTarget | null>(null);
  const close = useCallback(() => setMenu(null), []);

  const openFor = useCallback<WidgetContextMenu["openFor"]>((id, name, e) => {
    e.preventDefault();
    setMenu({ id, name, x: e.clientX, y: e.clientY });
  }, []);

  // 点击外部 / Esc 关闭（菜单自身 pointerdown 阻断冒泡防自关）。
  useEffect(() => {
    if (!menu) return;
    const onDown = () => close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, close]);

  const disable = useCallback(async () => {
    const target = menu;
    close();
    if (!target) return;
    try {
      await invokeCommand("plugin_set_enabled", { pluginId: target.id, enabled: false });
    } catch (err) {
      console.warn("[widget-menu] 停用失败:", err);
    }
  }, [menu, close]);

  const node = menu
    ? createPortal(
        <div
          className="fixed z-[90] w-44 rounded-lg border border-border/70 bg-popover/95 p-1 shadow-lg backdrop-blur"
          style={{
            left: Math.min(menu.x, window.innerWidth - 190),
            top: Math.min(menu.y, window.innerHeight - 96),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="truncate px-2 py-1 text-[10px] text-muted-foreground">{menu.name}</div>
          <button
            type="button"
            onClick={() => void disable()}
            className="w-full rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 transition-colors hover:bg-accent"
          >
            停用插件
          </button>
          <button
            type="button"
            onClick={() => {
              close();
              openManagePage("plugins");
            }}
            className="w-full rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 transition-colors hover:bg-accent"
          >
            在插件中心设置…
          </button>
        </div>,
        document.body,
      )
    : null;

  return { openFor, node };
}
