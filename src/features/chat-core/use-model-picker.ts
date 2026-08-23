import { useCallback, useEffect, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";

/**
 * v0.8.0 需求3：模型选择域 hook（chat-page 三域拆分之一）。
 *
 * 数据源是聚合 IPC `get_model_picker_options`（models.json 的
 * thinkingLevelMap/reasoning 解析唯一化在后端）——前端不再复刻 Pi 语义，
 * 模型表单与行为页同源消费。选择走既有 set_active，active 模型仍经
 * get_active 读取（读写路径不变，仅候选与档位来源收敛）。
 */

export interface ModelPickerOption {
  value: string;
  label: string;
  thinking_levels: string[];
  reasoning: boolean;
}

export interface UseModelPicker {
  options: ModelPickerOption[];
  activeValue: string | null;
  /** 当前激活模型的档位（从 options 派生；无激活/无声明回退默认集）。 */
  thinkingLevels: string[];
  reasoning: boolean;
  labelFor(value: string): string;
  select(value: string): Promise<void>;
  refresh(): Promise<void>;
}

const DEFAULT_LEVELS = ["off", "minimal", "low", "medium", "high"];

export function useModelPicker(
  agentId: string | null | undefined,
  enabled: boolean,
  onModelChanged?: () => void,
): UseModelPicker {
  const [options, setOptions] = useState<ModelPickerOption[]>([]);
  const [activeValue, setActiveValue] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled || !agentId) {
      setOptions([]);
      setActiveValue(null);
      return;
    }
    try {
      const [opts, act] = await Promise.all([
        invokeCommand<ModelPickerOption[]>("get_model_picker_options", { agentId }),
        invokeCommand<{ provider: string; model: string } | null>("get_active", { agentId }),
      ]);
      setOptions(opts);
      setActiveValue(act ? `${act.provider}/${act.model}` : null);
    } catch (e) {
      console.warn("Model picker refresh failed:", e);
    }
  }, [enabled, agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = useCallback(
    async (value: string) => {
      if (!agentId) return;
      const [provider, ...rest] = value.split("/");
      const model = rest.join("/");
      setActiveValue(value);
      try {
        await invokeCommand("set_active", { agentId, active: { provider, model } });
        onModelChanged?.();
      } catch (err) {
        console.warn("set_active failed:", err);
      }
    },
    [agentId, onModelChanged],
  );

  const activeOption = options.find((o) => o.value === activeValue);
  const thinkingLevels = activeOption?.thinking_levels?.length
    ? activeOption.thinking_levels
    : DEFAULT_LEVELS;

  const labelFor = useCallback(
    (value: string) => options.find((o) => o.value === value)?.label ?? value,
    [options],
  );

  return {
    options,
    activeValue,
    thinkingLevels,
    reasoning: activeOption?.reasoning ?? true,
    labelFor,
    select,
    refresh,
  };
}
