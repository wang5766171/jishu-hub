import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  loadLayout,
  railWidgetSideOf,
  saveLayout,
  type RailSide,
  type SessionLayoutState,
} from "../../shell/dock-layout";
import { listSessionPlugins, useEnabledSessionPlugins } from "../registry";
import { railWidgetsOf } from "../types";
import type { SessionKernelContext } from "../types";

/**
 * 贴边挂件宿主（v0.9.2 需求1 P4）：渲染所有「已启用 + 已挂 rail-widget」的
 * 插件，按布局记忆贴消息流左/右缘。宿主是通用容器，不含任何插件专属逻辑。
 *
 * 挂载位置：父容器需 position:relative（与 TurnRail 原绝对定位约束一致）。
 */
export function SessionRailSlot({ ctx }: { ctx: SessionKernelContext }) {
  const enabled = useEnabledSessionPlugins();
  const [layout, setLayout] = useState<SessionLayoutState>(() => loadLayout());

  // 布局变化落盘（拖拽切缘等操作经 setLayout 触发）。
  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  const widgets = listSessionPlugins()
    .filter((plugin) => enabled.has(plugin.id))
    .flatMap((plugin) =>
      railWidgetsOf(plugin).map((mount) => ({
        id: plugin.id,
        mount,
        side: railWidgetSideOf(layout, plugin.id),
      })),
    );

  if (widgets.length === 0) return null;

  return (
    <>
      {widgets.map(({ id, mount, side }) => {
        const Host = mount.Component;
        return (
          <div
            key={id}
            className={cn(
              "pointer-events-none absolute inset-y-0 z-10 flex w-6 flex-col items-center",
              side === "left" ? "left-0" : "right-0",
            )}
            data-rail-widget={id}
            data-rail-side={side}
            onDragOver={(e) => {
              // 挂件本体拖到对侧：拖拽体携带插件 id，落位切缘。
              if (e.dataTransfer.types.includes("application/x-jishu-rail")) {
                e.preventDefault();
              }
            }}
            onDrop={(e) => {
              const dragged = e.dataTransfer.getData("application/x-jishu-rail");
              if (dragged === id) {
                const next: RailSide = side === "left" ? "right" : "left";
                setLayout((prev) => {
                  const state = {
                    ...prev,
                    railWidgets: { ...prev.railWidgets, [id]: { side: next } },
                  };
                  return state;
                });
              }
            }}
          >
            <div
              className="flex h-full w-full items-center justify-center"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-jishu-rail", id);
                e.dataTransfer.effectAllowed = "move";
              }}
            >
              <Host ctx={ctx} />
            </div>
          </div>
        );
      })}
    </>
  );
}
