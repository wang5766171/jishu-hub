import { useEffect, useRef, useSyncExternalStore } from "react";

import { isNoSessionSelected } from "./session-placeholder";
import { isAppWindowActive, subscribeWindowActivity } from "./window-activity";

/**
 * 会话未读状态 store（v0.9.6 需求4 补充⑨，2026-11-06）。
 *
 * 绿/红点语义 = **未读结果通知**（回合完成=绿 / 失败=红，且用户尚未查看）：
 * - 产生：turn-complete 后台信号（正在查看的会话不发后台信号——天然不产生未读）
 * - 已读：**正在查看**——由 useUnreadClearedOnView 判定（跟着选中态走，见该函数）
 * - 持久：localStorage（关闭会话/重启后未读仍在）
 * 消费面：标题栏项目标签（按项目最近会话映射）+ 会话列表行（按会话）。
 * 模块级单例（与 session-cache 同模式），无 React 依赖。
 */

export type UnreadKind = "done" | "failed";

const KEY = "jishu-session-unread";

function readAll(): Record<string, UnreadKind> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, UnreadKind>) : {};
  } catch {
    return {};
  }
}

let state: Record<string, UnreadKind> = readAll();
const listeners = new Set<() => void>();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 存储异常静默——未读通知非关键数据 */
  }
}

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 单监听者异常不扩散 */
    }
  }
}

export function setUnread(sessionId: string, kind: UnreadKind): void {
  if (state[sessionId] === kind) return;
  state = { ...state, [sessionId]: kind };
  persist();
  emit();
}

export function clearUnread(sessionId: string): void {
  if (!(sessionId in state)) return;
  const next = { ...state };
  delete next[sessionId];
  state = next;
  persist();
  emit();
}

export function getUnread(sessionId: string): UnreadKind | undefined {
  return state[sessionId];
}

/** 全量快照（标签 hook 按项目最近会话映射用）。 */
export function unreadSnapshot(): Record<string, UnreadKind> {
  return state;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React 订阅 hook：任一未读变化触发重渲染。 */
export function useSessionUnread(): Record<string, UnreadKind> {
  return useSyncExternalStore(subscribe, unreadSnapshot, unreadSnapshot);
}

/** 占位选中态（空 / 新对话 / 节点会话待定）没有会话可清——判定见 session-placeholder。 */
function markViewed(sessionId: string | null | undefined): void {
  if (!isNoSessionSelected(sessionId)) clearUnread(sessionId as string);
}

/**
 * 「正在查看 = 已读」的**唯一判定点**（v0.9.8 需求24）。
 *
 * 清除不挂在任何一条「打开会话」的路径上，而是跟着选中态走：不管是谁把选中态改成了
 * 哪个会话（常规列表点击 / 任务行 / 节点会话 / 标签导航 / 通知跳转），只要这个会话
 * 正被显示，就清掉它的未读。此前清除只写在常规会话的打开函数里，任务会话的打开走
 * 另一条路（直接改选中态），点开任务行时绿点只是因为「这一行正被选中」暂时不显示，
 * 切到别的会话又出现。
 *
 * 窗口重新激活时同理：回合在窗口最小化 / 失焦时结束会记未读（那是为了弹系统通知），
 * 用户回到窗口时正看着这个会话——也算看过。
 */
export function useUnreadClearedOnView(selectedSession: string | null): void {
  const selectedRef = useRef(selectedSession);
  selectedRef.current = selectedSession;

  useEffect(() => {
    markViewed(selectedSession);
  }, [selectedSession]);

  useEffect(
    () =>
      subscribeWindowActivity(() => {
        if (isAppWindowActive()) markViewed(selectedRef.current);
      }),
    [],
  );
}
