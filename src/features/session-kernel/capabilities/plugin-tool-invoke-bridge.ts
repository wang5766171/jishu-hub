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
    // 三轮评审 C18：退订竞态守卫——effect cleanup 早于 import/listen 就绪
    // 到达时（StrictMode 双挂载/快速卸载），迟到的监听器必须立即退订，
    // 否则首个监听器泄漏、每个事件双执行。
    let disposed = false;
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
                    // 三轮评审 C19：agent 参数只作数据注入——过滤 type（防换
                    // 动作类型，handler 按 first.type 查得而 run 收合并值会错
                    // 乱）与 __ 前缀内部字段（防循环深度等被拉负/覆写）。
                    const safeArgs = Object.fromEntries(
                      Object.entries(args ?? {}).filter(
                        ([k]) => k !== "type" && !k.startsWith("__"),
                      ),
                    );
                    await handler.run(
                      { ...first, ...safeArgs },
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
        // C18：cleanup 已先行到达（import/listen 在途卸载）——立即退订刚
        // 注册的监听器，防泄漏与双执行。
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
    };
  }, []);
}
