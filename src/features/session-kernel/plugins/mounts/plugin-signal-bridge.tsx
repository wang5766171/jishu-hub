import { useEffect } from "react";
import { subscribeSessionSignals } from "../../signals";
import { listSessionPlugins } from "../registry";
import type { EventHookMount } from "../types";

/**
 * 事件钩子宿主（v0.9.2 需求1 M4）：把内核信号桥接到已启用插件的
 * event-hook 挂载点。无 UI；随启用集变化重挂订阅。
 */
export function PluginSignalBridge({ enabled }: { enabled: Set<string> }) {
  useEffect(() => {
    const hooks = listSessionPlugins()
      .filter((plugin) => enabled.has(plugin.id))
      .flatMap((plugin) =>
        plugin.mounts.filter((mount): mount is EventHookMount => mount.kind === "event-hook"),
      );
    if (hooks.length === 0) return;
    return subscribeSessionSignals((signal) => {
      for (const hook of hooks) hook.onSignal(signal);
    });
  }, [enabled]);
  return null;
}
