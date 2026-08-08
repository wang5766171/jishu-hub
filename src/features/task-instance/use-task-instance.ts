/**
 * useTaskInstance —— TaskInstance 状态管理 hook。
 *
 * 设计依据：`任务数据结构与生命周期设计_20260622.md` §6、§1.1、§2、§3.3.1。
 *           `任务入口与容器架构设计_20260622.md` §3.3、§4.6.1。
 *
 * 职责：任务实例列表、当前活跃任务/阶段、回溯只读、执行阶段视图与节点会话。
 * 消费：useChatSession（需求/规划阶段）、useTaskGraphExecution（执行阶段）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import {
  deriveAllPhaseStates,
  isTaskCompleted,
  taskInstanceFromRaw,
  type ExecutionChatScope,
  type NodeSessionInfo,
  type PhaseDisplayStates,
  type RequirementFinalizeRequest,
  type TaskInstance,
  type TaskInstanceRaw,
  type TaskPhase,
  type TaskRequirementFinalized,
} from "./types";

export type { NodeSessionInfo };

// 三阶段顺序：用于「阶段标签自动跟随」判定 current_phase 是否前进。
const PHASE_RANK: Record<TaskPhase, number> = {
  requirements: 0,
  planning: 1,
  execution: 2,
};

export interface UseTaskInstanceOptions {
  projectRoot: string;
  initialTaskId?: string | null;
}

export interface UseTaskInstanceResult {
  // ── 数据 ──
  instances: TaskInstance[];
  activeInstanceId: string | null;
  activeInstance: TaskInstance | null;
  activePhase: TaskPhase;
  readOnly: boolean;

  // ── 派生 ──
  phaseStates: PhaseDisplayStates;
  /** 当前阶段的活跃 session_id（执行阶段由 chatScope 决定，可能为 null = 主任务会话）。 */
  activeSessionId: string | null;

  // ── 执行阶段视图 ──
  chatScope: ExecutionChatScope;
  selectedNodeId: string | null;
  nodeSessionMap: Record<string, NodeSessionInfo>;

  // ── 动作 ──
  loadInstances: () => Promise<void>;
  openTask: (taskId: string) => void;
  openPhase: (phase: TaskPhase, readOnly?: boolean) => void;
  markSession: (sessionId: string, phase: TaskPhase, title?: string) => Promise<TaskInstance | null>;
  finalizeRequirements: (
    request: RequirementFinalizeRequest,
  ) => Promise<TaskRequirementFinalized | null>;
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
  const [activePhase, setActivePhase] = useState<TaskPhase>("requirements");
  const [readOnly, setReadOnly] = useState(false);

  // 执行阶段视图状态
  const [chatScope, setChatScope] = useState<ExecutionChatScope>({ kind: "run" });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeSessionMap, setNodeSessionMap] = useState<Record<string, NodeSessionInfo>>({});

  // skill id 保留（markSession 需要）。默认 conductor dev skill。
  const skillIdRef = useRef<string>("jishu-conductor-dev");

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

  // 初次加载 + projectRoot 变化时重载。
  useEffect(() => {
    loadInstances().catch(console.error);
  }, [loadInstances]);

  const activeInstance = useMemo(
    () => instances.find((i) => i.task_id === activeInstanceId) ?? null,
    [instances, activeInstanceId],
  );

  // activeInstance 变化时同步 skillIdRef。
  useEffect(() => {
    if (activeInstance?.skill_id) {
      skillIdRef.current = activeInstance.skill_id;
    }
  }, [activeInstance?.skill_id]);

  const phaseStates = useMemo(() => deriveAllPhaseStates(activeInstance), [activeInstance]);

  // B4+ 阶段标签自动跟随：current_phase 前进时自动切 tab。
  // conductor 在 chat turn 内调 conductor_sync_phase 推进 current_phase，turn 结束后容器
  // 调 loadInstances 刷新实例 → 此 effect 据此跟随。守卫：仅当用户仍停在刚完成的阶段
  // （activePhase === prev）才切，避免覆盖手动回看（手动回看时 current_phase 不变，effect 不触发）。
  const activePhaseRef = useRef(activePhase);
  activePhaseRef.current = activePhase;
  const prevCurrentPhaseRef = useRef<TaskPhase | null>(activeInstance?.current_phase ?? null);
  useEffect(() => {
    const next = activeInstance?.current_phase ?? null;
    const prev = prevCurrentPhaseRef.current;
    if (next && prev && PHASE_RANK[next] > PHASE_RANK[prev]) {
      // 阶段前进：仅当用户仍停在上一阶段（未手动挪开）才跟随。
      if (activePhaseRef.current === prev) {
        setActivePhase(next);
        if (next === "execution") {
          setChatScope({ kind: "run" });
        }
      }
    }
    prevCurrentPhaseRef.current = next;
  }, [activeInstance?.current_phase]);

  const activeSessionId = useMemo(() => {
    if (!activeInstance) return null;
    if (activePhase === "requirements") return activeInstance.requirement_session_id;
    if (activePhase === "planning") return activeInstance.planning_session_id;
    // execution: 取决于 chatScope
    if (chatScope.kind === "node") {
      return nodeSessionMap[chatScope.nodeId]?.session_id ?? null;
    }
    // run（主任务会话）：无真实 session_id
    return null;
  }, [activeInstance, activePhase, chatScope, nodeSessionMap]);

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
      // 完成态任务一律只读打开（设计 §11「已完成任务 phase=done 只读」）。
      // 此前无条件 setReadOnly(false)，重开已完成任务仍可编辑。
      setReadOnly(isTaskCompleted(inst ?? null));
      if (inst) {
        setActivePhase(inst.current_phase);
        // 进入执行阶段默认主任务会话 + 分屏
        if (inst.current_phase === "execution") {
          setChatScope({ kind: "run" });
        }
      }
    },
    [instances],
  );

  const openPhase = useCallback(
    (phase: TaskPhase, ro = false) => {
      setActivePhase(phase);
      // 完成态覆盖调用方意图：即便传 ro=false 也保持只读。
      setReadOnly(ro || isTaskCompleted(activeInstance));
      if (phase === "execution") {
        setChatScope({ kind: "run" });
      }
    },
    [activeInstance],
  );

  const markSession = useCallback(
    async (sessionId: string, phase: TaskPhase, title?: string): Promise<TaskInstance | null> => {
      if (!projectRoot) return null;
      try {
        const raw = await invokeCommand<TaskInstanceRaw>("task_launch_mark_session", {
          projectRoot,
          taskId: activeInstanceId,
          sessionId,
          skillId: skillIdRef.current,
          phase,
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
    [projectRoot, activeInstanceId, upsertLocalInstance],
  );

  const finalizeRequirements = useCallback(
    async (
      request: RequirementFinalizeRequest,
    ): Promise<TaskRequirementFinalized | null> => {
      if (!projectRoot) return null;
      try {
        const result = await invokeCommand<TaskRequirementFinalized>(
          "task_requirement_finalize",
          {
            projectRoot,
            request: { ...request, task_id: request.task_id ?? activeInstanceId },
          },
        );
        // 终稿后刷新实例（status → requirements_finalized）
        await loadInstances();
        return result;
      } catch (err) {
        console.error("finalizeRequirements failed:", err);
        return null;
      }
    },
    [projectRoot, activeInstanceId, loadInstances],
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
        // 先尝试清理 orchestrator graph（若存在 graph_id）
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
      // 切到该节点的子代理会话（若有 session_id）；否则保持 run
      setChatScope((prev) => {
        if (prev.kind === "node" && prev.nodeId === nodeId) return prev;
        return { kind: "node", nodeId, attemptNumber: 0 };
      });
    } else {
      setChatScope({ kind: "run" });
    }
  }, []);

  // 更新节点会话缓存（由 useTaskGraphExecution 轮询后回填）。
  const updateNodeSession = useCallback((nodeId: string, info: NodeSessionInfo) => {
    setNodeSessionMap((prev) => ({ ...prev, [nodeId]: info }));
  }, []);

  return {
    instances,
    activeInstanceId,
    activeInstance,
    activePhase,
    readOnly,
    phaseStates,
    activeSessionId,
    chatScope,
    selectedNodeId,
    nodeSessionMap,
    loadInstances,
    openTask,
    openPhase,
    markSession,
    finalizeRequirements,
    syncRunStatus,
    renameTask,
    deleteTask,
    setChatScope,
    selectNode,
    updateNodeSession,
    upsertLocalInstance,
  };
}
