/**
 * menu-page —— 菜单页打开通道（二十二轮用户裁决 2026-11-15：菜单与面板
 * 是同等挂载形式——菜单件用代码实现**独立页面**，入口在侧栏「新任务」
 * 下方，点击打开整页非会话页）。
 *
 * 与 panel-activation 同款一次性语义：请求 → 宿主（MenuPageHost，挂
 * chat-page 消息区）订阅并整页渲染该插件的 MenuPageMount.Component；
 * 生效即清空（宿主卸载-重挂不重放陈旧请求——侧栏粘滞 BUG 同款防线）。
 */
import { useSyncExternalStore } from "react";

export interface MenuPageRequest {
  pluginId: string;
  /** 自增序号：同一插件重复点击（再入口）也驱动消费。 */
  seq: number;
}

let request: MenuPageRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** 打开（或重复聚焦）某插件的菜单页。 */
export function requestMenuPage(pluginId: string): void {
  seq += 1;
  request = { pluginId, seq };
  emit();
}

function getRequest(): MenuPageRequest | null {
  return request;
}

/** 一次性消费语义：生效即清空（防宿主重挂重放）。 */
export function consumeMenuPage(): void {
  if (request === null) return;
  request = null;
  emit();
}

export function useMenuPageRequest(): MenuPageRequest | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getRequest,
  );
}
