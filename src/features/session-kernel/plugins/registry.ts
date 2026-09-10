import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand } from "@/hooks/use-invoke";
import { navigationPlugin } from "./builtin/navigation";
import { flowPanoramaPlugin } from "./builtin/flow-panorama";
import { htmlRenderPlugin } from "./builtin/html-render";
import { mermaidRenderPlugin } from "./builtin/mermaid-render";
import { desktopNotifyPlugin } from "./builtin/desktop-notify";
import { sessionExportPlugin } from "./builtin/session-export";
import { usagePanelPlugin } from "./builtin/usage-panel";
import { messageSearchPlugin } from "./builtin/message-search";
import { interactionRenderPlugin } from "./builtin/interaction-render";
import type { SessionPluginDescriptor } from "./types";

/**
 * 前端会话插件注册表（v0.9.2 需求1 P3）——镜像后端微内核形态：
 * 「id → 实现」映射 + 启用过滤。新增内置插件 = 新增一个描述符（零内核/
 * 宿主改动），这是 Stage 0 的开闭原则机械检验标准（05 §4）。
 *
 * 注册纪律：后端 `builtin_session_plugin_specs()` 与此处按 id 对齐；前端
 * 实现未落地不登记后端描述符（插件页不出现无实现的开关）。
 */
const BUILTIN_SESSION_PLUGINS: SessionPluginDescriptor[] = [
  navigationPlugin,
  flowPanoramaPlugin,
  htmlRenderPlugin,
  mermaidRenderPlugin,
  desktopNotifyPlugin,
  sessionExportPlugin,
  usagePanelPlugin,
  messageSearchPlugin,
  interactionRenderPlugin,
];

export function listSessionPlugins(): SessionPluginDescriptor[] {
  return BUILTIN_SESSION_PLUGINS;
}

export function findSessionPlugin(id: string): SessionPluginDescriptor | undefined {
  return BUILTIN_SESSION_PLUGINS.find((plugin) => plugin.id === id);
}

interface PluginListEntry {
  id: string;
  kind: string;
  enabled: boolean;
}

/**
 * 已启用的会话插件 id 集合（含 registry 内置实现交集）。
 * 数据源：后端统一插件清单（plugins.json 启停权威）；`plugins-changed`
 * 广播（插件页开关 → 后端热重建）即时刷新，无需重启。
 */
export function useEnabledSessionPlugins(): Set<string> {
  const [enabled, setEnabled] = useState<Set<string>>(() => defaultEnabled());

  const refresh = useCallback(async () => {
    try {
      const result = await invokeCommand<{ plugins: PluginListEntry[] }>("plugin_list");
      const enabledFromBackend = new Set(
        (result.plugins ?? [])
          .filter((p) => p.kind === "session" && p.enabled)
          .map((p) => p.id),
      );
      setEnabled(
        new Set(BUILTIN_SESSION_PLUGINS.map((p) => p.id).filter((id) => enabledFromBackend.has(id))),
      );
    } catch {
      // 查询失败保持当前值（默认全启用兜底）
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unlisten = listen("plugins-changed", () => void refresh());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  return enabled;
}

function defaultEnabled(): Set<string> {
  // 初值全启用：首次渲染（后端清单未返回前）不闪烁；后端权威值到达后校正。
  return new Set(BUILTIN_SESSION_PLUGINS.map((p) => p.id));
}
