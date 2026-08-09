import { invoke } from "@tauri-apps/api/core";
import { useState, useEffect, useCallback, useRef } from "react";

interface UseInvokeResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: (silent?: boolean) => Promise<T>;
  setData: (data: T | null) => void;
}

export function useInvoke<T>(command: string, args?: Record<string, unknown>, refreshKey?: number | string): UseInvokeResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every fetch invocation. Old in-flight promises that
  // resolve after a newer one started are ignored, so a slow
  // claude-code fetch can't overwrite a faster codex fetch's result
  // when the user switches agents.
  const runIdRef = useRef(0);
  // v0.7.0：记录上次 fetch 的 command/args，区分"参数变化的首次 fetch"（清空 data）
  // 和"同参数的 refetch"（保留 data）。
  const lastCommandRef = useRef<string | null>(null);
  const lastArgsRef = useRef<string | null>(null);

  const fetch = useCallback((silent?: boolean): Promise<T> => {
    const runId = ++runIdRef.current;
    if (!silent) setLoading(true);
    setError(null);
    if (!command) {
      setLoading(false);
      setData(null);
      return Promise.resolve(null as unknown as T);
    }
    // v0.7.0：command/args 变化（如 agent 切换）时先清空旧数据，避免新请求失败时
    // 残留上一个 agent 的数据。但同一参数的普通刷新（如 turn_complete 后 refetch）
    // 不清空——失败时保留已有数据更友好（如 list_sessions 遇到新项目目录不存在）。
    // 通过比较 runId 区分：args 变化触发的新 fetch（command/args 在 useCallback 依赖里
    // 变化才重建 fetch）清空；refetch（同参数）不清空。
    if (runId === 1 || command !== lastCommandRef.current || JSON.stringify(args) !== lastArgsRef.current) {
      setData(null);
    }
    lastCommandRef.current = command;
    lastArgsRef.current = JSON.stringify(args);
    return invoke<T>(command, args)
      .then((result) => {
        if (runId !== runIdRef.current) return result;
        setData(result);
        setLoading(false);
        return result;
      })
      .catch((err) => {
        if (runId !== runIdRef.current) throw err;
        setError(String(err));
        setLoading(false);
        throw err;
      });
  }, [command, JSON.stringify(args)]);

  useEffect(() => {
    fetch().catch((err) => {
      if (import.meta.env.DEV) console.warn("[useInvoke] fetch failed:", err);
    });
  }, [fetch, refreshKey]);

  return { data, loading, error, refetch: fetch, setData };
}

export async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}
