import { useCallback, useState } from "react";
import { invokeCommand, useInvoke } from "@/hooks/use-invoke";

/**
 * v0.8.0 需求3：压缩控制域 hook（chat-page 三域拆分之一）。
 *
 * 吸收 compact 控制/自动压缩开关状态（compact_agent_session /
 * get·set_agent_auto_compaction 的 IPC 与圆环弹层接线）。supportsCompact
 * 经 capability 注入（CONTEXT_COMPACT 门控），hook 不自行判断。
 */

export interface UseCompaction {
  autoCompaction: boolean | null;
  compacting: boolean;
  runCompact(
    sessionId: string | null,
    instructions?: string | null,
    extra?: { agentId?: string | null; projectPath?: string | null },
  ): Promise<void>;
  setAuto(enabled: boolean): Promise<void>;
}

export function useCompaction(
  agentId: string | null | undefined,
  enabled: boolean,
): UseCompaction {
  const [compacting, setCompacting] = useState(false);
  const { data: autoCompaction } = useInvoke<boolean | null>(
    enabled && agentId ? "get_agent_auto_compaction" : "",
    enabled && agentId ? { agentId } : undefined,
    agentId ?? undefined,
  );

  /** sessionId：会话内压缩目标（无会话时禁用）；instructions 可选摘要指令；
   * agentId/projectPath（v0.9.6 需求2）：无活跃进程的历史会话由后端先静默
   * 连接（resume）再压缩——两参用于该兜底的进程拉起。 */
  const runCompact = useCallback(
    async (
      sessionId: string | null,
      instructions?: string | null,
      extra?: { agentId?: string | null; projectPath?: string | null },
    ) => {
      if (!sessionId || sessionId === "new" || compacting) return;
      setCompacting(true);
      try {
        await invokeCommand("compact_agent_session", {
          sessionId,
          instructions: instructions ?? null,
          agentId: extra?.agentId ?? null,
          projectPath: extra?.projectPath ?? null,
        });
      } finally {
        setCompacting(false);
      }
    },
    [compacting],
  );

  const setAuto = useCallback(
    async (enabledValue: boolean) => {
      if (!agentId) return;
      await invokeCommand("set_agent_auto_compaction", {
        agentId,
        enabled: enabledValue,
      });
    },
    [agentId],
  );

  return { autoCompaction, compacting, runCompact, setAuto };
}
