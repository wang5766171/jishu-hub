/**
 * session-sidebar —— 侧边栏面板（sidebar-panel 挂载形态）的壳层状态
 * （v0.9.2 测试期，用户裁决：能力中心支持悬浮/侧栏两种形态）。
 *
 * 与 dock-layout 平行的壳层模块，只管插件无关的三件事：
 * ① openId——哪个 sidebar-plugin 展开；
 * ② userWidth——用户拖拽设定的宽度（localStorage 持久化；null = 未自定义）；
 * ③ effectiveWidth——实际渲染宽度（app 层 ViewerPushRow 按内容区测量回填，
 *   默认 = 内容区宽 × 50%——注意是「不含左侧导航的内容区」的一半，用户
 *   2026-09-12 裁决），面板与顶开 margin 共用同一数值保证齐边。
 */
import { useSyncExternalStore } from "react";

export const SESSION_SIDEBAR_WIDTH_RATIO = 0.5;
const WIDTH_STORAGE_KEY = "jishu-session-sidebar-width";
function loadUserWidth(): number | null {
  const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface SessionSidebarState {
  openId: string | null;
  /** 用户拖拽设定宽度（null = 默认比例）。 */
  userWidth: number | null;
  /** 实际生效宽度（px；ViewerPushRow 测量回填，面板/margin 共用）。 */
  effectiveWidth: number | null;
}

let state: SessionSidebarState = {
  openId: null,
  userWidth: loadUserWidth(),
  effectiveWidth: null,
};
const listeners = new Set<() => void>();

function set(next: Partial<SessionSidebarState>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

export function openSessionSidebar(pluginId: string): void {
  if (state.openId === pluginId) return;
  set({ openId: pluginId });
}

export function closeSessionSidebar(): void {
  if (state.openId === null) return;
  set({ openId: null });
}

export function toggleSessionSidebar(pluginId: string): void {
  if (state.openId === pluginId) closeSessionSidebar();
  else openSessionSidebar(pluginId);
}

/** 用户拖拽设定宽度（px；持久化）。null = 恢复默认比例。 */
export function setSessionSidebarUserWidth(px: number | null): void {
  if (px === null) {
    localStorage.removeItem(WIDTH_STORAGE_KEY);
    set({ userWidth: null });
    return;
  }
  localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(px)));
  set({ userWidth: Math.round(px) });
}

/** ViewerPushRow 按内容区测量回填的生效宽度（面板与 margin 共用）。 */
export function setSessionSidebarEffectiveWidth(px: number | null): void {
  if (state.effectiveWidth === px) return;
  set({ effectiveWidth: px });
}

/** 宽度收敛：直接复用文件预览的钳制（窗口宽基准 + 主区保底——用户裁决
 * 「参考文件预览的逻辑」，不要内容区 80% 上限）。 */
export { clampPanelWidth as clampSidebarWidth } from "@/lib/panel-width";

export function getSessionSidebarState(): SessionSidebarState {
  return state;
}

export function subscribeSessionSidebar(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useSessionSidebar(): SessionSidebarState {
  return useSyncExternalStore(subscribeSessionSidebar, getSessionSidebarState);
}
