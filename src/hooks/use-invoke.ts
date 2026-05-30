import { invoke } from "@tauri-apps/api/core";
import { useState, useEffect, useCallback } from "react";

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

  const fetch = useCallback((silent?: boolean): Promise<T> => {
    if (!silent) setLoading(true);
    setError(null);
    if (!command) {
      setLoading(false);
      setData(null);
      return Promise.resolve(null as unknown as T);
    }
    return invoke<T>(command, args)
      .then((result) => {
        setData(result);
        setLoading(false);
        return result;
      })
      .catch((err) => {
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
