import { useCallback, useState } from "react";
import { invokeCommand, useInvoke } from "@/hooks/use-invoke";
import { streamStore } from "@/hooks/use-stream-store";

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
      // v0.9.6 需求1 完善修复①：乐观压缩分隔线——无进程的历史会话点击
      // 「立即压缩」后要静默 spawn 连接（可达 30s+），此前这段时间会话窗
      // 口毫无反馈。这里立即推一条「上下文压缩中…」divider 起纯压缩流：
      // 真实 compaction_start/end divider 到达时按原位替换（store 保证至多
      // 一条压缩分隔线），呈现无缝衔接。仅在无活跃流时推（有流=进程在，
      // 压缩命令直达、真实事件即刻到，乐观层多余）。
      const optimisticPushed = !streamStore.hasState(sessionId)
        && streamStore.pushTracked(sessionId, {
          session_id: sessionId,
          event_type: "chunk",
          data: {
            kind: "phase_divider",
            phase: "compaction",
            title: "上下文压缩中…",
          } as never,
        });
      try {
        await invokeCommand("compact_agent_session", {
          sessionId,
          instructions: instructions ?? null,
          agentId: extra?.agentId ?? null,
          projectPath: extra?.projectPath ?? null,
        });
      } catch (err) {
        // 乐观分隔线回滚：失败（连接超时/压缩报错）时若流仍是我们乐观起的
        // 纯压缩流（无其他内容），整体 drop 恢复点击前状态——错误信息由
        // 调用方弹窗呈现；若期间真实事件已到（不再是纯压缩流），交给事件
        // 流自身生命周期处理，不动。
        if (optimisticPushed) {
          const st = streamStore.getState(sessionId);
          if (st && st.pendingUserMessage === null && st.text === ""
            && st.thinking === "" && st.tools.length === 0
            && st.steerTexts.length === 0 && !st.error) {
            streamStore.drop(st.resolvedId ?? sessionId);
            streamStore.drop(sessionId);
          }
        }
        throw err;
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
