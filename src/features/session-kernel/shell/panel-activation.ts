/**
 * panel-activation —— 面板激活性（ctx.openPanel 命令的落点，v0.9.2 测试期）。
 *
 * 命令链：插件调 ctx.openPanel(pluginId) → 本 store 记录请求 → 宿主层
 * （SessionPanelLayer，布局唯一所有者）订阅并按插件声明的形态生效：
 * dock-panel → 悬浮展开 / sidebar-panel → 侧栏顶开；单选互斥。
 * 插件不直接触碰布局状态——「布局归宿主，插件不越权」。
 */
import { useSyncExternalStore } from "react";

export interface PanelActivation {
  pluginId: string;
  /** 自增序号：同一插件重复请求（如连续 preview_html 刷新）也驱动消费。 */
  seq: number;
}

let activation: PanelActivation | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function requestPanelActivation(pluginId: string): void {
  seq += 1;
  activation = { pluginId, seq };
  emit();
}

/** 收起当前面板（openPanel 的对称命令；插件如 html-preview 关闭最后
 * 一个标签时收起整个侧栏）。 */
export function requestPanelClose(): void {
  seq += 1;
  activation = { pluginId: "__close__", seq };
  emit();
}

function getPanelActivation(): PanelActivation | null {
  return activation;
}

export function usePanelActivation(): PanelActivation | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getPanelActivation,
  );
}
