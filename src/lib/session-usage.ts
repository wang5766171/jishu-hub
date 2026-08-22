/**
 * 会话用量累计（v0.7.3 需求2-A4/A10，对齐 Pi TUI footer 的用量可见性）。
 *
 * 数据源：turn_complete 归一化事件携带的 usage（Rust `UsageStats`：
 * input_tokens / output_tokens / total_cost / context_remaining，均可缺省）。
 * 按会话 id（优先 resolved id）累加，GUI 内跨页面共享。
 *
 * v0.8.0 需求8：累计值持久化到 localStorage（jishu:session-usage，v1 结构，
 * 按 updatedAt 保留最近 500 个会话防无界增长）——重启后圆环立即可见，
 * 不必等新一轮 turn_complete。读写失败静默降级（隐私模式/存储损坏时
 * 回退为旧的易失行为）。
 */

export interface TurnUsagePayload {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_cost?: number | null;
  context_remaining?: number | null;
  context_window_total?: number | null;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  /** 最近一次上报的剩余上下文（绝对 token 数；缺省为 null）。 */
  contextRemaining: number | null;
  /** 最近一次上报的上下文总窗口（水位百分比分母；缺省为 null）。 */
  contextWindowTotal: number | null;
  updatedAt: number;
}

interface PersistedUsageV1 {
  v: 1;
  sessions: Record<string, SessionUsage>;
}

const STORAGE_KEY = "jishu:session-usage";
const MAX_PERSISTED_SESSIONS = 500;

function isValidUsage(value: unknown): value is SessionUsage {
  if (typeof value !== "object" || value === null) return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u.inputTokens === "number" && Number.isFinite(u.inputTokens)
    && typeof u.outputTokens === "number" && Number.isFinite(u.outputTokens)
    && typeof u.totalCost === "number" && Number.isFinite(u.totalCost)
    && (u.contextRemaining === null || (typeof u.contextRemaining === "number" && Number.isFinite(u.contextRemaining)))
    && (u.contextWindowTotal === null || (typeof u.contextWindowTotal === "number" && Number.isFinite(u.contextWindowTotal)))
    && typeof u.updatedAt === "number" && Number.isFinite(u.updatedAt)
  );
}

function loadPersisted(): Map<string, SessionUsage> {
  const map = new Map<string, SessionUsage>();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return map;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return map;
    const container = parsed as { v?: unknown; sessions?: unknown };
    if (container.v !== 1 || typeof container.sessions !== "object" || container.sessions === null) {
      return map;
    }
    for (const [id, entry] of Object.entries(container.sessions as Record<string, unknown>)) {
      if (id && isValidUsage(entry)) map.set(id, entry);
    }
  } catch {
    // 存储损坏/不可用：回退空表，运行期重新累计。
  }
  return map;
}

function persistStore(): void {
  try {
    let entries = Array.from(store.entries());
    if (entries.length > MAX_PERSISTED_SESSIONS) {
      entries = entries
        .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_PERSISTED_SESSIONS);
    }
    const payload: PersistedUsageV1 = { v: 1, sessions: Object.fromEntries(entries) };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 写入失败（隐私模式/超限）静默放弃——仅失去跨重启持久化。
  }
}

const store = loadPersisted();
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
    || payload.context_remaining != null
    || payload.context_window_total != null;
  if (!hasAny) return;

  const prev = store.get(sessionId);
  store.set(sessionId, {
    inputTokens: (prev?.inputTokens ?? 0) + (payload.input_tokens ?? 0),
    outputTokens: (prev?.outputTokens ?? 0) + (payload.output_tokens ?? 0),
    totalCost: (prev?.totalCost ?? 0) + (payload.total_cost ?? 0),
    contextRemaining: payload.context_remaining ?? prev?.contextRemaining ?? null,
    contextWindowTotal: payload.context_window_total ?? prev?.contextWindowTotal ?? null,
    updatedAt: Date.now(),
  });
  emit();
  persistStore();
}

/** 清空某会话累计（会话删除等场景预留）。 */
export function clearSessionUsage(sessionId: string): void {
  if (store.delete(sessionId)) {
    persistStore();
    emit();
  }
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

/** 测试辅助：清空全部累计（连同持久化副本）。 */
export function resetAllSessionUsageForTest(): void {
  store.clear();
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略：测试环境存储不可用。
  }
  emit();
}

/** 测试辅助：读取某会话当前累计快照。 */
export function getSessionUsageSnapshotForTest(sessionId: string): SessionUsage | null {
  return snapshotFor(sessionId);
}
