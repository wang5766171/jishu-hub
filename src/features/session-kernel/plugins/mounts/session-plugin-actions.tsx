import { useTranslation } from "react-i18next";
import { listSessionPlugins } from "../registry";
import type { HeaderActionMount, SessionKernelContext } from "../types";

/**
 * 会话头部动作宿主（v0.9.2 需求1 M4）：渲染已启用插件的 header-action
 * 挂载点（导出等轻动作按钮）。通用容器，无插件专属逻辑。
 */
export function SessionPluginActions({
  ctx,
  enabled,
}: {
  ctx: SessionKernelContext;
  enabled: Set<string>;
}) {
  const { t } = useTranslation();
  const actions = listSessionPlugins()
    .filter((plugin) => enabled.has(plugin.id))
    .flatMap((plugin) =>
      plugin.mounts.filter((mount): mount is HeaderActionMount => mount.kind === "header-action"),
    );
  if (actions.length === 0) return null;
  return (
    <>
      {actions.map((action, index) => {
        const Icon = action.icon;
        return (
          <button
            key={index}
            type="button"
            title={t(action.labelKey, action.labelFallback)}
            aria-label={t(action.labelKey, action.labelFallback)}
            onClick={() => action.onClick(ctx)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-fast hover:bg-accent hover:text-foreground"
          >
            {Icon ? <Icon className="h-4 w-4" /> : null}
          </button>
        );
      })}
    </>
  );
}
