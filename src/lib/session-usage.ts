/**
 * 会话用量累计（v0.7.3 需求2-A4/A10，对齐 Pi TUI footer 的用量可见性）。
 *
 * 数据源：turn_complete 归一化事件携带的 usage（Rust `UsageStats`：
 * input_tokens / output_tokens / total_cost / context_remaining，均可缺省）。
 * 按会话 id（优先 resolved id）累加，GUI 内跨页面共享。
 *
 * v1 限制（记录在案）：只统计本次应用运行期间的事件，不回放 agent 的
 * JSONL 历史用量；重启后计数从零开始。
 */

export interface TurnUsagePayload {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_cost?: number | null;
  context_remaining?: number | null;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  /** 最近一次上报的剩余上下文（绝对 token 数；缺省为 null）。 */
  contextRemaining: number | null;
  updatedAt: number;
}

const store = new Map<string, SessionUsage>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function snapshotFor(sessionId: string | null | undefined): SessionUsage | null {
  if (!sessionId) return null;
  return store.get(sessionId) ?? null;
}

const emptySnapshot = null;

/** 记录一次 turn_complete 的用量（缺省字段跳过；context_remaining 为覆盖语义）。 */
export function recordSessionUsage(sessionId: string, payload: TurnUsagePayload | null | undefined): void {
  if (!sessionId || !payload) return;
  const hasAny =
    payload.input_tokens != null
    || payload.output_tokens != null
    || payload.total_cost != null
    || payload.context_remaining != null;
  if (!hasAny) return;

  const prev = store.get(sessionId);
  store.set(sessionId, {
    inputTokens: (prev?.inputTokens ?? 0) + (payload.input_tokens ?? 0),
    outputTokens: (prev?.outputTokens ?? 0) + (payload.output_tokens ?? 0),
    totalCost: (prev?.totalCost ?? 0) + (payload.total_cost ?? 0),
    contextRemaining: payload.context_remaining ?? prev?.contextRemaining ?? null,
    updatedAt: Date.now(),
  });
  emit();
}

/** 清空某会话累计（会话删除等场景预留）。 */
export function clearSessionUsage(sessionId: string): void {
  if (store.delete(sessionId)) emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

import { useSyncExternalStore } from "react";

/** 订阅某会话的累计用量（无数据返回 null）。 */
export function useSessionUsage(sessionId: string | null | undefined): SessionUsage | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      void version; // 版本号递增驱动快照失效
      return sessionId ? snapshotFor(sessionId) : emptySnapshot;
    },
    () => emptySnapshot,
  );
}

/** 测试辅助：清空全部累计。 */
export function resetAllSessionUsageForTest(): void {
  store.clear();
  emit();
}

/** 测试辅助：读取某会话当前累计快照。 */
export function getSessionUsageSnapshotForTest(sessionId: string): SessionUsage | null {
  return snapshotFor(sessionId);
}
