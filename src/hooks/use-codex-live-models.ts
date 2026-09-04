/**
 * codex 官方直连的实时模型清单（v0.9.0 需求14）。
 *
 * 数据源：后端 get_model_picker_options → CodexAdapter::ModelStore →
 * app-server `model/list`（10 分钟后端缓存）。**无静态兜底表**（用户裁决：
 * 历史静态表列出的型号与账号可用集脱节，正是「选中即 400」问题的源头）；
 * 拉取中/失败为空数组，用户仍可经自由输入手填模型 id（既有自定义记忆通道）。
 */
import { useInvoke } from "./use-invoke";

export function useCodexLiveModels(
  agentId: string | null | undefined,
  enabled: boolean,
): string[] {
  const { data } = useInvoke<Array<{ value: string }>>(
    enabled && agentId ? "get_model_picker_options" : "",
    agentId ? { agentId } : undefined,
  );
  return (data ?? [])
    .map((o) => o.value.replace(/^codex\//, ""))
    .filter(Boolean);
}
