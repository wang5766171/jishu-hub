/**
 * plugin-tool-invoke 前端执行桥（v0.9.5 需求1（原需求26）6b，方向四）。
 *
 * 链路终点：agent 经 plugin-invoke 扩展调用 → hub_invoke Rust 闸门（校验
 * 物化清单）→ emit 本事件 → 此处执行插件动作（清单 [[action]][0]，agent
 * 参数融进 params）+ 轻提示（用户可见 agent 触发了什么）。
 */
import { useEffect } from "react";
import { invokeCommand } from "@/hooks/use-invoke";

export function usePluginToolInvokeBridge(): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ pluginId: string; tool: string; args?: Record<string, unknown> }>(
          "plugin-tool-invoke",
          (event) => {
            void (async () => {
              const { pluginId, tool, args } = event.payload;
              try {
                const items = (await invokeCommand<Array<{
                  id: string;
                  manifest: {
                    plugin?: { name?: string };
                    action?: Array<Record<string, unknown>>;
                  };
                }>>("composed_plugin_manifests")) ?? [];
                const item = items.find((x) => x.id === pluginId);
                const first = item?.manifest.action?.[0];
                if (item && first) {
                  const { actionRegistry } = await import(
                    "@/features/session-kernel/capabilities/actions"
                  );
                  const handler = actionRegistry.get(String(first.type));
                  if (handler) {
                    await handler.run(
                      { ...first, ...(args ?? {}) },
                      { kind: "aggregate", data: [] } as never,
                      { sessionId: null, pluginId },
                    );
                    console.info(
                      `[agent-tool] ${tool}（插件 ${item.manifest.plugin?.name ?? pluginId}）已执行`,
                    );
                    return;
                  }
                }
                // 无动作绑定：面板型插件兜底展开（agent 触发"使用"语义）。
                const { runPluginQuickAction } = await import("@/lib/plugin-quick-run");
                const fired = await runPluginQuickAction(pluginId, null);
                if (!fired) {
                  console.warn(`[agent-tool] ${tool}：插件 ${pluginId} 无可执行动作`);
                }
              } catch (err) {
                console.warn(`[agent-tool] ${tool} 执行失败:`, err);
              }
            })();
          },
        ),
      )
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, []);
}
