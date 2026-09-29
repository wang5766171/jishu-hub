import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { listSessionPlugins } from "../registry";
import { getPluginBehavior, useAllPluginBehaviors } from "../config-plane";
// 批次5 能力中心常驻定位（动作位）+ 差异性完善（06 ui.confirm）。
import { useInstallSpotlight } from "../../shell/install-spotlight";
import type { HeaderActionMount, SessionKernelContext } from "../types";

/**
 * 会话头部动作宿主（v0.9.2 需求1 M4）：渲染已启用插件的 header-action
 * 挂载点（导出等轻动作按钮）。通用容器，无插件专属逻辑。
 *
 * 差异性完善（06 §5.2 ui.confirm）：行为键「执行前确认」——点击后先弹
 * 确认框再执行动作。快捷键触发（ui.shortcut）由 panel-layer 快捷键框架
 * 统一承接（面板 toggle 语义；纯动作键位后续批次）。
 */
export function SessionPluginActions({
  ctx,
  enabled,
}: {
  ctx: SessionKernelContext;
  enabled: Set<string>;
}) {
  const { t } = useTranslation();
  const { confirm: confirmDialog } = useConfirmDialog();
  const behaviors = useAllPluginBehaviors();
  // 能力中心「常驻挂件 · 点击定位」：动作位按钮脉冲一次。
  const spotlight = useInstallSpotlight();
  const [pulsing, setPulsing] = useState(false);
  useEffect(() => {
    if (!spotlight) return;
    // 任意 spotlight 目标含 header-action 挂载即脉冲本区（定位语义）。
    const target = listSessionPlugins().find(
      (p) =>
        p.id === spotlight.pluginId && p.mounts.some((m) => m.kind === "header-action"),
    );
    if (!target) return;
    setPulsing(true);
    const timer = window.setTimeout(() => setPulsing(false), 3000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotlight?.seq]);

  const actions = listSessionPlugins()
    .filter((plugin) => enabled.has(plugin.id))
    .flatMap((plugin) => {
      const bhv = behaviors[plugin.id];
      if (bhv?.scope === "task-only" && ctx.task == null) return [];
      return plugin.mounts
        .filter((mount): mount is HeaderActionMount => mount.kind === "header-action")
        .map((mount) => ({ mount, pluginId: plugin.id }));
    });

  const runAction = async (action: HeaderActionMount, pluginId: string, label: string) => {
    const needConfirm = getPluginBehavior(pluginId).confirm === true;
    if (needConfirm) {
      const ok = await confirmDialog({
        title: label,
        description: t("plugins.behaviorConfirmRun", "该动作已开启「执行前确认」——确认执行？"),
      });
      if (!ok) return;
    }
    action.onClick(ctx);
  };

  if (actions.length === 0) return null;
  return (
    <span
      className={
        pulsing ? "inline-flex animate-pulse rounded-md ring-2 ring-primary/60" : "inline-flex"
      }
    >
      {actions.map(({ mount: action, pluginId }, index) => {
        const Icon = action.icon;
        const label = t(action.labelKey, action.labelFallback);
        return (
          <button
            key={`${pluginId}:${index}`}
            type="button"
            title={label}
            aria-label={label}
            onClick={() => void runAction(action, pluginId, label)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-fast hover:bg-accent hover:text-foreground"
          >
            {Icon ? <Icon className="h-4 w-4" /> : null}
          </button>
        );
      })}
    </span>
  );
}
