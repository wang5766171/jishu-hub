import { useCallback, useRef, useState } from "react";
import { invokeCommand, useInvoke } from "@/hooks/use-invoke";
import { streamStore } from "@/hooks/use-stream-store";
import { isNoSessionSelected } from "@/features/session-kernel/session-placeholder";

/**
 * v0.8.0 需求3：压缩控制域 hook（chat-page 三域拆分之一）。
 *
 * 吸收 compact 控制/自动压缩开关状态（compact_agent_session /
 * get·set_agent_auto_compaction 的 IPC 与圆环弹层接线）。supportsCompact
 * 经 capability 注入（CONTEXT_COMPACT 门控），hook 不自行判断。
 *
 * v0.9.8 评审修复轮 R2：压缩进行态**按会话**记。此前是一个页面级布尔——
 * A 会话压缩期间，别的会话的压缩入口一并禁用、再点也被重入闸拦下。一次
 * 压缩请求从发出到引擎返回，全程只属于发起它的那个会话。
 */

export interface UseCompaction {
  autoCompaction: boolean | null;
  /** 正在压缩的会话（渲染用快照；某会话的请求返回时只清它自己）。 */
  compactingSessions: ReadonlySet<string>;
  /** 同步查询某会话是否在压缩——回调里读，拿到的永远是最新值。 */
  isCompacting(sessionId: string): boolean;
  runCompact(
    sessionId: string | null,
    instructions?: string | null,
    extra?: { agentId?: string | null; projectPath?: string | null },
  ): Promise<"done" | "skipped">;
  setAuto(enabled: boolean): Promise<void>;
  /** 取走「这个会话当前这次压缩是用户发起的」标记（没有 = 这次压缩不是从界面发起的）。 */
  takeCompactionRequest(sessionId: string): boolean;
}

export function useCompaction(
  agentId: string | null | undefined,
  enabled: boolean,
): UseCompaction {
  const [compactingSessions, setCompactingSessions] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // 同步重入闸：state 要到下一次渲染才对闭包可见——连点、连按两次回车会穿过
  // 闭包里的判断对同一个会话发出两个压缩请求（第二个到达引擎会中止第一个）。
  // 按会话键：同一个会话只放行一个在途请求，不同会话互不影响。
  const inFlightRef = useRef(new Set<string>());
  // 用户发起的压缩（立即压缩 / 排队的压缩轮到时）按会话记一个标记，事件管线在压缩结束时取走：
  // 只有用户发起的压缩结束才轮到待发送区的下一条（裁决 4：压缩与普通消息同队）——引擎在
  // 自己起的回合开头做的自动压缩不是队列里的一员，那时回合还在跑，不能把排队的消息发出去。
  // 标记留着直到被取走：压缩结束事件可能晚于压缩命令的返回到达。
  const requestedRef = useRef(new Set<string>());
  const takeCompactionRequest = useCallback((sessionId: string): boolean => {
    const had = requestedRef.current.has(sessionId);
    requestedRef.current.delete(sessionId);
    return had;
  }, []);
  const { data: autoCompaction } = useInvoke<boolean | null>(
    enabled && agentId ? "get_agent_auto_compaction" : "",
    enabled && agentId ? { agentId } : undefined,
    agentId ?? undefined,
  );

  const isCompacting = useCallback(
    (sessionId: string) => inFlightRef.current.has(sessionId),
    [],
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
      if (!sessionId || isNoSessionSelected(sessionId) || inFlightRef.current.has(sessionId)) return "skipped";
      inFlightRef.current.add(sessionId);
      requestedRef.current.add(sessionId);
      setCompactingSessions((prev) => new Set(prev).add(sessionId));
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
        // 压缩没做成：不会有压缩结束事件来取标记，这里清掉
        requestedRef.current.delete(sessionId);
        // 乐观分隔线回滚：失败（连接超时/压缩报错）时若流仍是我们乐观起的
        // 纯压缩流（无其他内容），整体 drop 恢复点击前状态——错误信息由
        // 调用方弹窗呈现；若期间真实事件已到（不再是纯压缩流），交给事件
        // 流自身生命周期处理，不动。
        if (optimisticPushed) {
          const st = streamStore.getState(sessionId);
          if (st && st.pendingUserMessage === null && !st.committedUserMessage && st.text === ""
            && st.thinking === "" && st.tools.length === 0
            && st.steerTexts.length === 0 && !st.error) {
            streamStore.drop(st.resolvedId ?? sessionId);
            streamStore.drop(sessionId);
          }
        }
        throw err;
      } finally {
        inFlightRef.current.delete(sessionId);
        setCompactingSessions((prev) => {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
      }
      // 走到这里 = 压缩命令正常返回（分隔线的终态由事件流呈现）
      return "done";
    },
    [],
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

  return { autoCompaction, compactingSessions, isCompacting, runCompact, setAuto, takeCompactionRequest };
}
