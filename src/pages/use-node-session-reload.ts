/**
 * use-node-session-reload —— 节点会话的「数据晚到」补读。
 *
 * v0.9.8 需求24 续（用户裁决「任务会话的逻辑改成和普通会话一致」）：打开任何会话
 *（普通会话、任务主会话、节点子代理的会话）都走 handleSelectSession——记离开位置、
 * 收起预览、读消息、刷新用量、定位在那里只有一份。节点子代理的会话有三处数据会比
 * 「打开」晚到，打开函数那一次拿不到，由这里补读（读消息本身仍调同一份实现）：
 * - 会话属于哪个智能体（attempt 绑定的 agent_id）回填晚于会话 id → 绑定变化后重读；
 * - 节点刚启动时会话文件还没落盘（读到空）→ 隔 1.5 秒重试，最多 3 次；
 * - 后台节点的事件不进本视图，缓存往往是上次离开时的半截 → 进入后总从磁盘读最新。
 * 首条流式文本到达时也重读一次：把刚落盘的派发 prompt 补进来。
 *
 * 这里只管「什么时候重读」；定位、滚动记忆都不管（打开函数已经做了）。
 */
import { useEffect, type RefObject } from "react";
import { isNoSessionSelected } from "@/features/session-kernel/session-placeholder";
import type { ReloadSessionMessages } from "./use-session-selection";

export function useNodeSessionReload({
  taskModeActive,
  selectedSession,
  projectId,
  taskSelectedNodeId,
  taskNodeSessionAgentId,
  activeId,
  streamTextStarted,
  reloadSessionMessagesRef,
}: {
  taskModeActive: boolean;
  selectedSession: string | null;
  projectId: string | null;
  taskSelectedNodeId: string | null;
  taskNodeSessionAgentId: string | null;
  activeId: string | null;
  /** 首条流式文本已到达（布尔依赖，避免逐 delta 重读刷 IPC）。 */
  streamTextStarted: boolean;
  reloadSessionMessagesRef: RefObject<ReloadSessionMessages>;
}): void {
  useEffect(() => {
    if (!taskModeActive || !taskSelectedNodeId || !projectId) return;
    if (isNoSessionSelected(selectedSession)) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const agentId = taskNodeSessionAgentId ?? activeId ?? null;
    const read = (attempt: number) => {
      void Promise.resolve(reloadSessionMessagesRef.current(selectedSession, agentId, true)).then((messages) => {
        // 节点会话进入早于派发 prompt 落盘：JSONL 读空时有限重试，之后由
        // streamTextStarted 触发重读兜底。
        if (cancelled || messages.length > 0 || attempt >= 3) return;
        retryTimer = setTimeout(() => read(attempt + 1), 1500);
      });
    };
    read(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [taskModeActive, selectedSession, projectId, taskSelectedNodeId, taskNodeSessionAgentId, activeId, streamTextStarted, reloadSessionMessagesRef]);
}
