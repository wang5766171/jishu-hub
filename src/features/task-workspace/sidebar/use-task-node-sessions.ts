/**
 * useTaskNodeSessions —— 侧边栏树的节点会话查询 hook。
 *
 * 设计依据：`docs/task-exec-dev/02-总体设计.md` §6.1、§9（session_id 统一入口）。
 *
 * 调用 T0 的 `orchestrator_list_node_sessions(run_id)`，按 run_id 分组返回
 * 每个任务（通过 active_run_id 关联）的节点会话摘要列表。
 *
 * 特性：
 * - 按 run_id 缓存（run 不变不重查）
 * - orchestrator feature 关闭时降级为空（catch → []）
 * - 支持手动刷新（树展开时触发）
 * - 返回扁平 Map：taskId → NodeSessionSummary[]
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import type { NodeSessionSummary } from "../types";

export interface TaskNodeSessionsState {
  /** taskId → 节点会话列表 */
  sessionsByTask: Map<string, NodeSessionSummary[]>;
  /** taskId → 节点标题映射（nodeId → title，由后端返回的 node.title 直接填充） */
  titleMapsByTask: Map<string, Record<string, string>>;
  loading: boolean;
  /** 手动刷新 */
  refresh: () => void;
}

export interface UseTaskNodeSessionsOptions {
  /**
   * 任务摘要列表（来自 task_launch_list_sessions）。
   * 每项需含 task_id + active_run_id。
   */
  tasks: Array<{
    task_id: string;
    active_run_id?: string | null;
    last_run_id?: string | null;
    graph_id?: string | null;
    current_phase?: string;
  }>;
  /** 轮询间隔（ms），默认 0 = 不轮询 */
  pollInterval?: number;
}

export function useTaskNodeSessions({
  tasks,
  pollInterval = 0,
}: UseTaskNodeSessionsOptions): TaskNodeSessionsState {
  const [sessionsByTask, setSessionsByTask] = useState<Map<string, NodeSessionSummary[]>>(new Map());
  const [titleMapsByTask, setTitleMapsByTask] = useState<Map<string, Record<string, string>>>(
    new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const fetchAll = useCallback(async () => {
    const currentTasks = tasksRef.current;
    // 只查有 run_id 的任务（execution 阶段才有节点会话）
    const runnable = currentTasks.filter(
      (t) => t.active_run_id || t.last_run_id,
    );
    if (runnable.length === 0) {
      setSessionsByTask(new Map());
      setTitleMapsByTask(new Map());
      return;
    }

    setLoading(true);
    try {
      const results = await Promise.all(
        runnable.map(async (task) => {
          const runId = task.active_run_id ?? task.last_run_id!;
          try {
            // T8-P15：后端 list_node_sessions 已直接返回节点中文标题（title 字段），
            // 来自 run 实际执行的 revision（node_id 对齐）+ graph current_draft_revision 兜底。
            // 前端不再反查 revision，彻底消除 N1/N2 占位标题问题。
            const sessions = await invokeCommand<NodeSessionSummary[]>(
              "orchestrator_list_node_sessions",
              { runId },
            ).catch((err) => {
              console.warn(`[useTaskNodeSessions] list_node_sessions failed for run ${runId}:`, err);
              return [] as NodeSessionSummary[];
            });
            const titleMap: Record<string, string> = {};
            for (const s of sessions) {
              if (s.title && s.title.trim()) {
                titleMap[s.node_id] = s.title;
              }
            }
            return { taskId: task.task_id, sessions, titleMap };
          } catch {
            return { taskId: task.task_id, sessions: [], titleMap: {} as Record<string, string> };
          }
        }),
      );

      const next = new Map<string, NodeSessionSummary[]>();
      const nextTitles = new Map<string, Record<string, string>>();
      for (const result of results) {
        next.set(result.taskId, result.sessions);
        nextTitles.set(result.taskId, result.titleMap);
      }
      setSessionsByTask(next);
      setTitleMapsByTask(nextTitles);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll().catch(console.error);
  }, [fetchAll, refreshKey, JSON.stringify(tasks.map((t) => t.task_id + ":" + (t.active_run_id ?? t.last_run_id ?? "")))]);

  // 轮询
  useEffect(() => {
    if (pollInterval <= 0) return;
    const timer = window.setInterval(() => {
      fetchAll().catch(console.error);
    }, pollInterval);
    return () => window.clearInterval(timer);
  }, [fetchAll, pollInterval]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return { sessionsByTask, titleMapsByTask, loading, refresh };
}
