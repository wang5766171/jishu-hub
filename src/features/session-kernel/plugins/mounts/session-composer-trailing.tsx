import { useEffect, useState } from "react";
import { listSessionPlugins, useEnabledSessionPlugins } from "../registry";
import { composerTrailingsOf } from "../types";
import type { SessionKernelContext } from "../types";
// 5a（v0.9.5 需求1）：安装后挂件高亮（确认卡启用 → 位置提示一次）。
import { useInstallSpotlight } from "../../shell/install-spotlight";
import { useAllPluginBehaviors } from "../config-plane";
import { useWidgetContextMenu } from "./widget-context-menu";
import { cn } from "@/lib/utils";

/**
 * composer 尾部控制行宿主（v0.9.3 需求8：上下文占用环迁移为插件）：
 * 渲染所有「已启用 + 已挂 composer-trailing」的插件，内联在模型选择器/
 * 思考档同一行。宿主是通用容器，不含任何插件专属逻辑（与 rail 宿主同构）。
 */
export function SessionComposerTrailing({ ctx }: { ctx: SessionKernelContext }) {
  const enabled = useEnabledSessionPlugins();
  // 批次4：作用域过滤（task-only 仅任务会话呈现）——与面板/挂件同口径。
  const behaviors = useAllPluginBehaviors();
  const inTaskSession = ctx.task != null;
  const widgets = listSessionPlugins()
    .filter((plugin) => enabled.has(plugin.id))
    .filter((plugin) => {
      const bhv = behaviors[plugin.id];
      if (bhv?.scope === "task-only" && !inTaskSession) return false;
      // 差异性完善（06 ui.visible）：显隐开关（隐藏≠停用——插件仍启用）。
      if (bhv?.visible === false) return false;
      return true;
    })
    .flatMap((plugin) =>
      composerTrailingsOf(plugin).map((m) => ({ ...m, pluginId: plugin.id, name: plugin.displayNameFallback })),
    );
  // 5a：spotlight 目标（一次性 pulse，3s 后自动熄灭）。
  const spotlight = useInstallSpotlight();
  // 批次5：右键菜单（停用/在插件中心设置）。
  const widgetMenu = useWidgetContextMenu();
  const [pulsingId, setPulsingId] = useState<string | null>(null);
  useEffect(() => {
    if (!spotlight) return;
    setPulsingId(spotlight.pluginId);
    const timer = window.setTimeout(() => setPulsingId(null), 3000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotlight?.seq]);
  if (widgets.length === 0) return null;
  return (
    <>
      {widgets.map((mount) => {
        const Host = mount.Component;
        return (
          <span
            key={mount.pluginId}
            className={cn(
              "inline-flex",
              pulsingId === mount.pluginId && "animate-pulse rounded-md ring-2 ring-primary/60",
            )}
            // 批次5：右键 → 挂件管理菜单。
            onContextMenu={(e) => widgetMenu.openFor(mount.pluginId, mount.name, e)}
          >
            <Host ctx={ctx} />
          </span>
        );
      })}
      {widgetMenu.node}
    </>
  );
}
