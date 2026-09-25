import { useEffect, useState } from "react";
import { listSessionPlugins, useEnabledSessionPlugins } from "../registry";
import { composerTrailingsOf } from "../types";
import type { SessionKernelContext } from "../types";
// 5a（v0.9.5 需求1）：安装后挂件高亮（确认卡启用 → 位置提示一次）。
import { useInstallSpotlight } from "../../shell/install-spotlight";
import { cn } from "@/lib/utils";

/**
 * composer 尾部控制行宿主（v0.9.3 需求8：上下文占用环迁移为插件）：
 * 渲染所有「已启用 + 已挂 composer-trailing」的插件，内联在模型选择器/
 * 思考档同一行。宿主是通用容器，不含任何插件专属逻辑（与 rail 宿主同构）。
 */
export function SessionComposerTrailing({ ctx }: { ctx: SessionKernelContext }) {
  const enabled = useEnabledSessionPlugins();
  const widgets = listSessionPlugins()
    .filter((plugin) => enabled.has(plugin.id))
    .flatMap((plugin) => composerTrailingsOf(plugin).map((m) => ({ ...m, pluginId: plugin.id })));
  // 5a：spotlight 目标（一次性 pulse，3s 后自动熄灭）。
  const spotlight = useInstallSpotlight();
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
          >
            <Host ctx={ctx} />
          </span>
        );
      })}
    </>
  );
}
