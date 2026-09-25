/**
 * 会话头部插件快捷区（v0.9.5 需求1（原需求26）5c）：当前启用的面板类
 * 插件图标横排——一键打开/关闭面板（不用去能力中心找）。
 *
 * 与 SessionPluginActions（插件声明的 header-action 按钮）互补：本区是
 * 宿主自动生成的面板开关（数据源 = 组合式插件描述符的面板挂载），
 * 点击 toggle（已激活 → 收起；未激活 → 展开并单选互斥）。
 */
import { useMemo } from "react";
import { LayoutDashboard } from "lucide-react";
import { composedPlugins, subscribeComposed, composedVersion } from "../../capabilities/composition/loader";
import { useSyncExternalStore } from "react";
import {
  usePanelActivation,
  requestPanelActivation,
  requestPanelClose,
} from "../../shell/panel-activation";

export function SessionPanelShortcuts({ enabled }: { enabled: Set<string> }) {
  // 组合式插件表（loader 版本快照——启停/新建热更新）。
  useSyncExternalStore(subscribeComposed, composedVersion, () => 0);
  const activation = usePanelActivation();

  const panels = useMemo(
    () =>
      composedPlugins().filter(
        (p) =>
          enabled.has(p.id) &&
          p.mounts.some((m) => m.kind === "dock-panel" || m.kind === "sidebar-panel"),
      ),
    [enabled, ],
  );

  if (panels.length === 0) return null;

  return (
    <>
      {panels.map((p) => {
        const isActive = activation?.pluginId === p.id;
        return (
          <button
            key={p.id}
            type="button"
            title={`${p.displayNameFallback}（${isActive ? "收起" : "展开"}面板）`}
            aria-label={`${p.displayNameFallback}（${isActive ? "收起" : "展开"}面板）`}
            onClick={() => {
              if (isActive) {
                requestPanelClose();
              } else {
                requestPanelActivation(p.id);
              }
            }}
            className={
              "flex h-7 items-center justify-center gap-1 rounded-md px-1.5 text-[10px] transition-fast " +
              (isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground")
            }
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            <span className="max-w-14 truncate">{p.displayNameFallback}</span>
          </button>
        );
      })}
    </>
  );
}
