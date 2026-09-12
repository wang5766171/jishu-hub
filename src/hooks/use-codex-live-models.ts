/**
 * 官方直连实时模型清单（v0.9.0 需求14 → v0.9.2 需求9 改版）。
 *
 * 需求9（用户裁决）：**首次自动查询、后续人工刷新**——
 * - 会话级缓存（module state）：本次应用生命周期内只自动查一次，之后进
 *   页面直接展示缓存，靠刷新按钮更新；
 * - 刷新按钮由组件渲染（本 hook 暴露 refresh/loading）。
 * 数据源：后端 get_model_picker_options → codex app-server `model/list`
 * （10 分钟后端缓存）。**无静态兜底表**（用户裁决：静态表与账号可用集
 * 脱节，正是「选中即 400」源头）；拉取失败为空，用户仍可自由输入手填。
 */
import { useCallback, useState } from "react";
import { useInvoke } from "./use-invoke";

/** 会话级缓存：应用生命周期内只自动查一次（null = 未查过）。 */
let sessionCache: string[] | null = null;

export function useCodexLiveModels(
  agentId: string | null | undefined,
  enabled: boolean,
): {
  models: string[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [manual, setManual] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);

  // 首查：仅当会话缓存为空时启用 IPC（后续进页面吃缓存，不重复查）。
  const { data, loading: invokeLoading, refetch } = useInvoke<Array<{ value: string }>>(
    enabled && agentId && sessionCache === null ? "get_model_picker_options" : "",
    enabled && agentId ? { agentId } : undefined,
  );

  const fresh = (data ?? []).map((o) => o.value.replace(/^codex\//, "")).filter(Boolean);
  if (enabled && fresh.length > 0 && sessionCache === null) {
    sessionCache = fresh;
  }

  const refresh = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      // refetch 强制同参数重拉（绕过会话缓存短路——cmd 固定，直接调命令）。
      const result = await refetch();
      const list = ((result as Array<{ value: string }> | undefined) ?? [])
        .map((o) => o.value.replace(/^codex\//, ""))
        .filter(Boolean);
      if (list.length > 0) sessionCache = list;
      setManual(list);
    } finally {
      setLoading(false);
    }
  }, [agentId, refetch]);

  // 展示优先级：手动刷新结果 > 会话缓存 > 首查结果
  const models = manual ?? sessionCache ?? fresh;
  return { models, loading: loading || invokeLoading, refresh };
}
