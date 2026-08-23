import { useCallback, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";

/**
 * v0.8.0 需求3：思考档位域 hook（chat-page 三域拆分之一）。
 *
 * levels 从 use-model-picker 的结果注入（参数传入，hooks 不互调——页面
 * 作为组合根组装）；生效值经 thinking_level_changed 事件的页面接线回写
 * （本 hook 持有显示值与切换 IPC，事件回写仍由页面路由到 setValue）。
 */

export interface UseThinkingLevel {
  value: string | null;
  setValue(v: string): void;
  setLevel(level: string): Promise<void>;
}

export function useThinkingLevel(agentId: string | null | undefined): UseThinkingLevel {
  const [value, setValue] = useState<string | null>(null);

  const setLevel = useCallback(
    async (level: string) => {
      setValue(level);
      if (!agentId) return;
      try {
        await invokeCommand("set_agent_thinking_level", {
          sessionId: null,
          agentId,
          level,
        });
      } catch (err) {
        console.error("Failed to set thinking level:", err);
      }
    },
    [agentId],
  );

  return { value, setValue, setLevel };
}
