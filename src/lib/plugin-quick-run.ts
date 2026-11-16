/**
 * 插件快捷执行（v0.9.5 需求1（原需求26）5e/5f 共享）：面板型插件展开 /
 * 动作型插件执行清单 action[0]。消费方：会话内 /plugin 命令（5f）、
 * Ctrl+K 命令面板（5e）。
 */
import { invokeCommand } from "@/hooks/use-invoke";
import { requestPanelActivation } from "@/features/session-kernel/shell/panel-activation";

/** 触发插件默认使用。返回 false = 未命中（调用方提示）。 */
export async function runPluginQuickAction(
  pluginId: string,
  sessionId: string | null,
): Promise<boolean> {
  try {
    const items = (await invokeCommand<
      Array<{
        id: string;
        manifest: {
          render?: { mount?: string };
          action?: Array<Record<string, unknown>>;
        };
      }>
    >("composed_plugin_manifests")) ?? [];
    const item = items.find((x) => x.id === pluginId);
    if (!item) return false;
    const mount = item.manifest.render?.mount;
    if (mount === "dock-panel" || mount === "sidebar-panel") {
      requestPanelActivation(pluginId);
      return true;
    }
    const first = (item.manifest.action ?? [])[0];
    if (first) {
      const { actionRegistry } = await import("@/features/session-kernel/capabilities/actions");
      const handler = actionRegistry.get(String(first.type));
      if (handler) {
        await handler.run(first, { kind: "aggregate", data: [] } as never, {
          sessionId,
          pluginId,
        });
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** 可快捷执行的插件清单（命令面板/自动补全数据源）。 */
export async function listQuickActions(): Promise<
  Array<{
    pluginId: string;
    name: string;
    kind: "panel" | "action";
    actionLabel?: string;
  }>
> {
  try {
    const items = (await invokeCommand<
      Array<{
        id: string;
        manifest: {
          plugin?: { name?: string };
          render?: { mount?: string };
          action?: Array<Record<string, unknown>>;
        };
      }>
    >("composed_plugin_manifests")) ?? [];
    const out: Array<{ pluginId: string; name: string; kind: "panel" | "action"; actionLabel?: string }> = [];
    for (const item of items) {
      const mount = item.manifest.render?.mount;
      const name = item.manifest.plugin?.name ?? item.id;
      if (mount === "dock-panel" || mount === "sidebar-panel") {
        out.push({ pluginId: item.id, name, kind: "panel" });
      } else {
        const first = (item.manifest.action ?? [])[0];
        if (first) {
          out.push({
            pluginId: item.id,
            name,
            kind: "action",
            actionLabel: String(first.label ?? first.type),
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
