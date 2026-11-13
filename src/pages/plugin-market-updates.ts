/**
 * 插件市场批量更新全局 store（v0.9.7 需求3 五轮裁决：离开页面不打断
 * 正在进行的更新——更新任务挂在模块级闭包，React 组件卸载不影响执行；
 * 重新进入页面经 useSyncExternalStore 恢复显示进行中状态）。
 *
 * 语义：
 * - extensionRunning/skillRunning：批量任务执行中（每卡片按钮显示转圈）
 * - done/total：进度（当前批量跑到第几个）
 * - 幂等：已在跑的任务不重复启动
 * - 完成后置 finishedAt（短暂保留完成态，前端可提示）
 */
import { useSyncExternalStore } from "react";
import { invokeCommand } from "@/hooks/use-invoke";

export interface MarketUpdateState {
  extensionRunning: boolean;
  extensionTotal: number;
  extensionDone: number;
  skillRunning: boolean;
  skillTotal: number;
  skillDone: number;
}

let state: MarketUpdateState = {
  extensionRunning: false,
  extensionTotal: 0,
  extensionDone: 0,
  skillRunning: false,
  skillTotal: 0,
  skillDone: 0,
};

const listeners = new Set<() => void>();

function set(patch: Partial<MarketUpdateState>) {
  state = { ...state, ...patch };
  for (const fn of listeners) {
    try { fn(); } catch { /* 单监听者异常不扩散 */ }
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function snapshot(): MarketUpdateState {
  return state;
}

/** React 订阅（组件挂载即恢复显示进行中的任务状态）。 */
export function useMarketUpdates(): MarketUpdateState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 批量更新全部有更新的扩展（逐包更新，进度推进；离开页面继续跑）。 */
export function startExtensionUpdateAll(): void {
  if (state.extensionRunning) return;
  set({ extensionRunning: true, extensionDone: 0, extensionTotal: 0 });
  void (async () => {
    try {
      const updates = await invokeCommand<Array<{ package: string; hasUpdate: boolean }>>(
        "extension_check_updates",
      );
      const pending = (updates ?? []).filter((u) => u.hasUpdate);
      set({ extensionTotal: pending.length, extensionDone: 0 });
      for (const u of pending) {
        try {
          await invokeCommand("extension_update", { packages: [u.package] });
        } catch (e) {
          console.warn("[market-updates] 扩展更新失败:", u.package, e);
        }
        set({ extensionDone: state.extensionDone + 1 });
      }
    } catch (e) {
      console.warn("[market-updates] 扩展批量检查失败:", e);
    } finally {
      set({ extensionRunning: false });
    }
  })();
}

/** 批量更新全部有更新的技能。 */
export function startSkillUpdateAll(): void {
  if (state.skillRunning) return;
  set({ skillRunning: true, skillDone: 0, skillTotal: 0 });
  void (async () => {
    try {
      const updates = await invokeCommand<Array<{ slug: string; hasUpdate: boolean }>>(
        "skillhub_check_updates",
      );
      const pending = (updates ?? []).filter((u) => u.hasUpdate);
      set({ skillTotal: pending.length, skillDone: 0 });
      for (const u of pending) {
        try {
          await invokeCommand("skillhub_update", { slugs: [u.slug] });
        } catch (e) {
          console.warn("[market-updates] 技能更新失败:", u.slug, e);
        }
        set({ skillDone: state.skillDone + 1 });
      }
    } catch (e) {
      console.warn("[market-updates] 技能批量检查失败:", e);
    } finally {
      set({ skillRunning: false });
    }
  })();
}

/** 仍有批量任务在跑（完成刷新轮询用）。 */
export function updatesPending(): boolean {
  return state.extensionRunning || state.skillRunning;
}
