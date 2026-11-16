import { useSyncExternalStore } from "react";

/**
 * 会话未读状态 store（v0.9.6 需求4 补充⑨，2026-11-06）。
 *
 * 绿/红点语义 = **未读结果通知**（回合完成=绿 / 失败=红，且用户尚未查看）：
 * - 产生：turn-complete 后台信号（正在查看的会话不发后台信号——天然不产生未读）
 * - 已读：会话被选中打开 / 标签对应项目被切换查看 → 清除
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
