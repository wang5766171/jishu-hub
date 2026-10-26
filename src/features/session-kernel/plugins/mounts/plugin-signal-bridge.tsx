import { useEffect } from "react";
import { subscribeSessionSignals } from "../../signals";
import { listSessionPlugins } from "../registry";
import type { EventHookMount, SessionKernelContext } from "../types";

/**
 * 事件钩子宿主（v0.9.2 需求1 M4）：把内核信号桥接到已启用插件的
 * event-hook 挂载点。无 UI；随启用集变化重挂订阅。
 * v0.9.2 测试期：onSignal 补 ctx 入参（file-preview-request → ctx.openPanel
 * 这类「事件驱动拉起面板」需要内核命令面）。
 */
export function PluginSignalBridge({
  enabled,
  ctx,
}: {
  enabled: Set<string>;
  ctx: SessionKernelContext;
}) {
  useEffect(() => {
    const hooks = listSessionPlugins()
      .filter((plugin) => enabled.has(plugin.id))
      .flatMap((plugin) =>
        plugin.mounts.filter((mount): mount is EventHookMount => mount.kind === "event-hook"),
      );
    if (hooks.length === 0) return;
    return subscribeSessionSignals((signal) => {
      for (const hook of hooks) hook.onSignal(signal, ctx);
    });
  }, [enabled, ctx]);
  return null;
}
