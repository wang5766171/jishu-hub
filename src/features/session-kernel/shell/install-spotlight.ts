/**
 * install-spotlight —— 安装后挂件高亮（v0.9.5 需求1（原需求26）5a）。
 *
 * 场景：用户经确认卡启用新装的 rail-widget / composer-trailing 挂件后，
 * 「装好了在哪用？」——挂件位置高亮闪烁一次（提示位置，不用去能力中心
 * 找）。与 panel-activation 同款外部 store 模式：确认卡请求 → 挂件宿主
 * （SessionPanelLayer）订阅并对目标插件容器施加一次性 pulse 动画。
 */
import { useSyncExternalStore } from "react";

export interface InstallSpotlight {
  pluginId: string;
  seq: number;
}

let spotlight: InstallSpotlight | null = null;
let seq = 0;
type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** 请求高亮指定插件（确认卡「启用」成功后调用）。 */
export function requestInstallSpotlight(pluginId: string): void {
  seq += 1;
  spotlight = { pluginId, seq };
  emit();
}

function getSpotlight(): InstallSpotlight | null {
  return spotlight;
}

export function useInstallSpotlight(): InstallSpotlight | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSpotlight,
    () => null,
  );
}
