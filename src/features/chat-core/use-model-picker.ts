import { useCallback, useEffect, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";

/**
 * v0.8.0 需求3：模型选择域 hook（chat-page 三域拆分之一）。
 *
 * 数据源是聚合 IPC `get_model_picker_options`（models.json 的
 * thinkingLevelMap/reasoning 解析唯一化在后端）——前端不再复刻 Pi 语义，
 * 模型表单与行为页同源消费。
 *
 * v0.9.7 需求14：**会话级模型**——`sessionKey`（当前会话真实 id）非空时，
 * 选择写入会话锁定（`session_model_set`，只影响本会话，不动全局 active）；
 * 新会话（sessionKey 空/"new"）仍写全局（新会话尚无 id 可锁定，且「新
 * 会话选模型」语义上就是设接下来的默认）。显示值：会话锁定 > 全局 active。
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
  sessionKey?: string | null,
): UseModelPicker {
  const [options, setOptions] = useState<ModelPickerOption[]>([]);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  // 会话锁定模型（null=未锁定，跟随全局）。切会话时刷新显示。
  const [sessionModel, setSessionModel] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled || !agentId) {
      setOptions([]);
      setActiveValue(null);
      setSessionModel(null);
      return;
    }
    try {
      const [opts, act, sess] = await Promise.all([
        invokeCommand<ModelPickerOption[]>("get_model_picker_options", { agentId }),
        invokeCommand<{ provider: string; model: string } | null>("get_active", { agentId }),
        // session_model_get 返回 Rust Option<(String,String)>——序列化为
        // 元组数组 [provider, model]（非对象；按对象取值曾致 "undefined/undefined"）。
        sessionKey
          ? invokeCommand<[string, string] | null>("session_model_get", { sessionId: sessionKey })
          : Promise.resolve(null),
      ]);
      setOptions(opts);
      setActiveValue(act ? `${act.provider}/${act.model}` : null);
      setSessionModel(sess ? `${sess[0]}/${sess[1]}` : null);
    } catch (e) {
      console.warn("Model picker refresh failed:", e);
    }
  }, [enabled, agentId, sessionKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = useCallback(
    async (value: string) => {
      if (!agentId) return;
      const [provider, ...rest] = value.split("/");
      const model = rest.join("/");
      const perSession = !!sessionKey && sessionKey !== "new";
      setSessionModel(perSession ? value : null);
      if (!perSession) setActiveValue(value);
      try {
        if (perSession) {
          // 需求14：只锁定当前会话（全局 active 不动——其他会话不受影响；
          // 本会话进程按启动签名漂移在下次空闲发送时重拉）。
          (await import("@/lib/dev-log")).devLog("ipc", "模型切换（会话级）", { to: model, provider, session: sessionKey });
          await invokeCommand("session_model_set", { sessionId: sessionKey, provider, model });
        } else {
          // v0.9.4 需求12：模型切换语义埋点（下次 send 触发签名漂移回收重拉——
          // 后续 send_message 耗时会显著变长，此标记用于对齐时序）。
          (await import("@/lib/dev-log")).devLog("ipc", "模型切换（全局）", { to: model, provider });
          await invokeCommand("set_active", { agentId, active: { provider, model } });
        }
        onModelChanged?.();
      } catch (err) {
        console.warn(perSession ? "session_model_set failed:" : "set_active failed:", err);
      }
    },
    [agentId, onModelChanged, sessionKey],
  );

  const shownValue = sessionModel ?? activeValue;
  const activeOption = options.find((o) => o.value === shownValue);

  const labelFor = useCallback(
    (value: string) => options.find((o) => o.value === value)?.label ?? value,
    [options],
  );

  return {
    options,
    activeValue: shownValue,
    thinkingLevels: activeOption?.thinking_levels?.length
      ? activeOption.thinking_levels
      : DEFAULT_LEVELS,
    reasoning: activeOption?.reasoning ?? true,
    labelFor,
    select,
    refresh,
  };
}
