import { listSessionPlugins, useEnabledSessionPlugins } from "../registry";
import { composerTrailingsOf } from "../types";
import type { SessionKernelContext } from "../types";

/**
 * composer 尾部控制行宿主（v0.9.3 需求8：上下文占用环迁移为插件）：
 * 渲染所有「已启用 + 已挂 composer-trailing」的插件，内联在模型选择器/
 * 思考档同一行。宿主是通用容器，不含任何插件专属逻辑（与 rail 宿主同构）。
 */
export function SessionComposerTrailing({ ctx }: { ctx: SessionKernelContext }) {
  const enabled = useEnabledSessionPlugins();
  const widgets = listSessionPlugins()
    .filter((plugin) => enabled.has(plugin.id))
    .flatMap((plugin) => composerTrailingsOf(plugin));
  if (widgets.length === 0) return null;
  return (
    <>
      {widgets.map((mount) => {
        const Host = mount.Component;
        return <Host key={mount.Component.name || "composer-trailing"} ctx={ctx} />;
      })}
    </>
  );
}
