/**
 * 会话用量的前端缓存层（v0.8.0 需求10 重构）。
 *
 * 权威来源是 Hub 侧 SQLite（usage.db）：Rust 在 turn_end 记账，与前端页面
 * 是否在场无关。本模块只做展示缓存——`get_session_usage` 命令拉取后经
 * `setSessionUsage` 写入，圆环组件经 `useSessionUsage` 订阅。
 * （历史：v0.7.3 起为前端内存累计、需求8 曾迁 localStorage——均因切页/重启
 * 漏计与「记录类数据优先 SQLite」原则被取代。）
 */

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalCost: number;
  /** 最近一次上报的剩余上下文（绝对 token 数；缺省为 null）。 */
  contextRemaining: number | null;
  /** 最近一次上报的上下文总窗口（水位百分比分母；缺省为 null）。 */
  contextWindowTotal: number | null;
  /** 输出构成估算（≈2.5 字符/token 粗估，仅供对比）。 */
  estThinking: number;
  estText: number;
  estBuiltinTool: number;
  /** 前向预留：MCP 归因（暂无标志，计入 estBuiltinTool 展示）。 */
  estMcpTool: number;
  estToolResults: number;
  toolCalls: number;
  segments: number;
  compactions: number;
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

/** 用后端权威数据整行覆盖缓存（get_session_usage 命令的返回写入点）。 */
export function setSessionUsage(sessionId: string, row: SessionUsage): void {
  if (!sessionId) return;
  store.set(sessionId, row);
  emit();
}

/** 清空某会话缓存（会话删除等场景预留）。 */
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
      return snapshotFor(sessionId);
    },
    () => emptySnapshot,
  );
}

/** 测试辅助：清空全部缓存。 */
export function resetAllSessionUsageForTest(): void {
  store.clear();
  emit();
}

/** 测试辅助：读取某会话当前缓存快照。 */
export function getSessionUsageSnapshotForTest(sessionId: string): SessionUsage | null {
  return snapshotFor(sessionId);
}
