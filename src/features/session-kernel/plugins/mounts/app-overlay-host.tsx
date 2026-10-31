/**
 * 需求14 M5（06-P2/G12）：应用级浮层宿主——页面层外常驻（app.tsx 全局
 * 浮层区，与确认模态/命令面板并列挂载，跨页存活）。消费启用中组合插件的
 * app-overlay 挂载（无会话 ctx 的全局形态；DevLogCenter 形态的第三方位）。
 * 启停两层语义铁律不变：插件中心开关 = 存不存在（本宿主过滤 enabled）。
 */
import { useEffect, useState, useSyncExternalStore, type ComponentType } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { listSessionPlugins } from "../registry";
import {
  composedVersion,
  subscribeComposed,
} from "@/features/session-kernel/capabilities/composition/loader";

export function AppOverlayHost() {
  useSyncExternalStore(subscribeComposed, composedVersion, () => 0);
  const [enabledIds, setEnabledIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const list = await invokeCommand<{ plugins: Array<{ id: string; kind: string; enabled: boolean }> }>(
          "plugin_list",
        );
        if (alive) {
          setEnabledIds(
            new Set((list.plugins ?? []).filter((p) => p.kind === "session" && p.enabled).map((p) => p.id)),
          );
        }
      } catch {
        if (alive) setEnabledIds(null);
      }
    };
    void load();
    const onChanged = () => void load();
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("plugins-changed", onChanged))
      .then((un) => {
        if (alive) return;
        void un();
      })
      .catch(() => undefined);
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const overlays: Array<{ id: string; Component: ComponentType }> = [];
  for (const plugin of listSessionPlugins()) {
    if (enabledIds && !enabledIds.has(plugin.id)) continue;
    for (const mount of plugin.mounts) {
      if (mount.kind === "app-overlay") {
        overlays.push({ id: plugin.id, Component: mount.Component });
      }
    }
  }
  if (overlays.length === 0) return null;
  return (
    <>
      {overlays.map(({ id, Component }) => (
        <Component key={id} />
      ))}
    </>
  );
}
