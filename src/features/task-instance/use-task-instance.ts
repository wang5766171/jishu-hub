/**
 * useTaskInstance —— TaskInstance 状态管理 hook（v0.9.7 需求2 去阶段化）。
 *
 * 职责：任务实例列表、当前活跃任务、步骤卡数据（stages_json）、执行视图
 * 与节点会话（B2 保留清单）。单对话流：activeSessionId = task_session_id
 *（或节点会话）；阶段 tab/phase 派生/需求定稿链路已随三阶段概念退役。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import {
  isTaskCompleted,
  taskInstanceFromRaw,
  type ExecutionChatScope,
  type NodeSessionInfo,
  type RunnerCard,
  type TaskInstance,
  type TaskInstanceRaw,
} from "./types";
import { parseRunnerCard } from "./types";

export type { NodeSessionInfo };

export interface UseTaskInstanceOptions {
  projectRoot: string;
  initialTaskId?: string | null;
}

export interface UseTaskInstanceResult {
  // ── 数据 ──
  instances: TaskInstance[];
  activeInstanceId: string | null;
  activeInstance: TaskInstance | null;
  readOnly: boolean;

  // ── 派生 ──
  /** 任务卡（状态灯）数据：stages_json 解析。 */
  runnerCard: RunnerCard;
  /** 当前会话 id（节点视图取节点会话；主对话取 task_session_id）。 */
  activeSessionId: string | null;

  // ── 执行视图 ──
  chatScope: ExecutionChatScope;
  selectedNodeId: string | null;
  nodeSessionMap: Record<string, NodeSessionInfo>;

  // ── 动作 ──
  loadInstances: () => Promise<void>;
  openTask: (taskId: string) => void;
  markSession: (sessionId: string, title?: string) => Promise<TaskInstance | null>;
  syncRunStatus: (runId: string, runStatus: string) => Promise<TaskInstance | null>;
  renameTask: (title: string) => Promise<TaskInstance | null>;
  deleteTask: (taskId: string) => Promise<void>;
  setChatScope: (scope: ExecutionChatScope) => void;
  selectNode: (nodeId: string | null) => void;
  updateNodeSession: (nodeId: string, info: NodeSessionInfo) => void;
  upsertLocalInstance: (instance: TaskInstance) => void;
}

export function useTaskInstance(options: UseTaskInstanceOptions): UseTaskInstanceResult {
  const { projectRoot, initialTaskId } = options;

  const [instances, setInstances] = useState<TaskInstance[]>([]);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(initialTaskId ?? null);
  const [readOnly, setReadOnly] = useState(false);

  const [chatScope, setChatScope] = useState<ExecutionChatScope>({ kind: "run" });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeSessionMap, setNodeSessionMap] = useState<Record<string, NodeSessionInfo>>({});

  const loadInstances = useCallback(async () => {
    if (!projectRoot) {
      setInstances([]);
      return;
    }
    try {
      const rawList = await invokeCommand<TaskInstanceRaw[]>("task_launch_list_sessions", {
        projectRoot,
      });
      const list = (rawList ?? []).map(taskInstanceFromRaw);
      setInstances(list);
    } catch (err) {
      console.error("Failed to load task instances:", err);
      setInstances([]);
    }
  }, [projectRoot]);

  useEffect(() => {
    loadInstances().catch(console.error);
  }, [loadInstances]);

  const activeInstance = useMemo(
    () => instances.find((i) => i.task_id === activeInstanceId) ?? null,
    [instances, activeInstanceId],
  );

  const runnerCard = useMemo(() => parseRunnerCard(activeInstance?.stages_json), [activeInstance?.stages_json]);

  const activeSessionId = useMemo(() => {
    if (chatScope.kind === "node") {
      return nodeSessionMap[chatScope.nodeId]?.session_id ?? null;
    }
    return activeInstance?.task_session_id ?? null;
  }, [activeInstance, chatScope, nodeSessionMap]);

  const upsertLocalInstance = useCallback((instance: TaskInstance) => {
    setInstances((prev) => {
      const idx = prev.findIndex((i) => i.task_id === instance.task_id);
      if (idx === -1) return [instance, ...prev];
      const next = [...prev];
      next[idx] = instance;
      return next;
    });
  }, []);

  const openTask = useCallback(
    (taskId: string) => {
      const inst = instances.find((i) => i.task_id === taskId);
      setActiveInstanceId(taskId);
      // 完成态任务只读打开。
      setReadOnly(isTaskCompleted(inst ?? null));
      setChatScope({ kind: "run" });
    },
    [instances],
  );

  const markSession = useCallback(
    async (sessionId: string, title?: string): Promise<TaskInstance | null> => {
      if (!projectRoot) return null;
      const skillId = activeInstance?.skill_id ?? "jishu-task-runner";
      try {
        const raw = await invokeCommand<TaskInstanceRaw>("task_launch_mark_session", {
          projectRoot,
          taskId: activeInstanceId,
          sessionId,
          skillId,
          title: title ?? null,
        });
        const instance = taskInstanceFromRaw(raw);
        upsertLocalInstance(instance);
        if (!activeInstanceId) setActiveInstanceId(instance.task_id);
        return instance;
      } catch (err) {
        console.error("markSession failed:", err);
        return null;
      }
    },
    [projectRoot, activeInstanceId, activeInstance?.skill_id, upsertLocalInstance],
  );

  const syncRunStatus = useCallback(
    async (runId: string, runStatus: string): Promise<TaskInstance | null> => {
      if (!projectRoot || !activeInstanceId) return null;
      try {
        const raw = await invokeCommand<TaskInstanceRaw>("task_launch_sync_run_status", {
          projectRoot,
          taskId: activeInstanceId,
          runId,
          runStatus,
        });
        const instance = taskInstanceFromRaw(raw);
        upsertLocalInstance(instance);
        return instance;
      } catch (err) {
        console.error("syncRunStatus failed:", err);
        return null;
      }
    },
    [projectRoot, activeInstanceId, upsertLocalInstance],
  );

  const renameTask = useCallback(
    async (title: string): Promise<TaskInstance | null> => {
      if (!projectRoot || !activeInstanceId) return null;
      try {
        const raw = await invokeCommand<TaskInstanceRaw>("task_launch_rename_task", {
          projectRoot,
          taskId: activeInstanceId,
          title,
        });
        const instance = taskInstanceFromRaw(raw);
        upsertLocalInstance(instance);
        return instance;
      } catch (err) {
        console.error("renameTask failed:", err);
        return null;
      }
    },
    [projectRoot, activeInstanceId, upsertLocalInstance],
  );

  const deleteTask = useCallback(
    async (taskId: string): Promise<void> => {
      if (!projectRoot) return;
      try {
        const inst = instances.find((i) => i.task_id === taskId);
        if (inst?.graph_id) {
          try {
            await invokeCommand("orchestrator_delete_graph", { graphId: inst.graph_id });
          } catch (err) {
            console.warn("deleteTask: orchestrator_delete_graph failed (may be missing):", err);
          }
        }
        await invokeCommand("task_launch_delete_task", { projectRoot, taskId });
        setInstances((prev) => prev.filter((i) => i.task_id !== taskId));
        if (activeInstanceId === taskId) {
          setActiveInstanceId(null);
        }
      } catch (err) {
        console.error("deleteTask failed:", err);
      }
    },
    [projectRoot, instances, activeInstanceId],
  );

  const selectNode = useCallback((nodeId: string | null): void => {
    setSelectedNodeId(nodeId);
    if (nodeId) {
      setChatScope((prev) => {
        if (prev.kind === "node" && prev.nodeId === nodeId) return prev;
        return { kind: "node", nodeId, attemptNumber: 0 };
      });
    } else {
      setChatScope({ kind: "run" });
    }
  }, []);

  const updateNodeSession = useCallback((nodeId: string, info: NodeSessionInfo) => {
    setNodeSessionMap((prev) => ({ ...prev, [nodeId]: info }));
  }, []);

  return {
    instances,
    activeInstanceId,
    activeInstance,
    readOnly,
    runnerCard,
    activeSessionId,
    chatScope,
    selectedNodeId,
    nodeSessionMap,
    loadInstances,
    openTask,
    markSession,
    syncRunStatus,
    renameTask,
    deleteTask,
    setChatScope,
    selectNode,
    updateNodeSession,
    upsertLocalInstance,
  };
}
