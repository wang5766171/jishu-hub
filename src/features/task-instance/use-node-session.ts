/**
 * useNodeSession —— 执行阶段节点子代理会话查询。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §4.6、§4.6.1。
 *           `任务数据结构与生命周期设计_20260622.md` §3.3、§4.4 NodeSessionInfo。
 *
 * 职责：按需查询节点最新 attempt 的 session_id + agent 信息，回填 useTaskInstance.nodeSessionMap。
 * 约束（§4.6.1）：只查询当前选中的节点（按需挂载），未选中节点不查询。
 */
import { useCallback } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import type { NodeRunProjection, RunProjection } from "@/features/task-workbench/use-task-graph";
import type { NodeSessionInfo } from "./use-task-instance";

/** orchestrator_get_attempt 返回的 NodeAttempt（精简版，只取需要的字段）。 */
interface NodeAttempt {
  attempt_id: string;
  node_run_id: string;
  attempt_number: number;
  agent_assignment: { agent_id: string; role_id: string } | null;
  session_id: string | null;
}

export interface UseNodeSessionOptions {
  /** 当前 run 的投影（用于读取 nodeRuns）。 */
  projection: RunProjection | null;
  /** 回填到 useTaskInstance.nodeSessionMap。 */
  onNodeSession: (nodeId: string, info: NodeSessionInfo) => void;
}

export interface UseNodeSessionResult {
  /** 查询单个节点的最新 attempt（回填 nodeSessionMap）。
   *  返回 session_id（可能为 null，表示该节点尚未产生 attempt）。 */
  fetchNodeSession: (nodeId: string) => Promise<NodeSessionInfo | null>;
  /** 批量查询所有有 attempt 的节点（减少 N+1，但当前后端无批量接口，逐个查询）。
   *  仅在需要全量刷新时调用。 */
  refreshAllNodeSessions: () => Promise<void>;
}

export function useNodeSession(options: UseNodeSessionOptions): UseNodeSessionResult {
  const { projection, onNodeSession } = options;

  const fetchNodeSession = useCallback(
    async (nodeId: string): Promise<NodeSessionInfo | null> => {
      if (!projection) return null;
      const nodeRun = findNodeRun(projection, nodeId);
      if (!nodeRun || nodeRun.attempt_count <= 0) return null;
      // attempt_number 从 0 开始，最新 attempt = attempt_count - 1
      const attemptNumber = nodeRun.attempt_count - 1;
      try {
        const attempt = await invokeCommand<NodeAttempt>("orchestrator_get_attempt", {
          nodeRunId: nodeRun.node_run_id,
          attemptNumber,
        });
        if (!attempt) return null;
        const info: NodeSessionInfo = {
          node_id: nodeId,
          node_run_id: nodeRun.node_run_id,
          attempt_number: attemptNumber,
          session_id: attempt.session_id,
          status: nodeRun.status,
          agent_id: attempt.agent_assignment?.agent_id ?? null,
        };
        onNodeSession(nodeId, info);
        return info;
      } catch (err) {
        console.error(`fetchNodeSession(${nodeId}) failed:`, err);
        return null;
      }
    },
    [projection, onNodeSession],
  );

  const refreshAllNodeSessions = useCallback(async () => {
    if (!projection) return;
    const entries = Object.values(projection.node_runs);
    for (const nodeRun of entries) {
      if (nodeRun.attempt_count > 0) {
        await fetchNodeSession(nodeRun.node_id);
      }
    }
  }, [projection, fetchNodeSession]);

  return {
    fetchNodeSession,
    refreshAllNodeSessions,
  };
}

function findNodeRun(
  projection: RunProjection,
  nodeId: string,
): NodeRunProjection | null {
  return projection.node_runs[nodeId] ?? null;
}
