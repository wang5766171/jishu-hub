/**
 * 任务实例同步（v0.9.3 需求10 A5 簇①，chat-page 拆解）：
 * 任务会话列表 + 节点子会话 id 的装载/轮询/事件刷新/快照应用整体迁出。
 *
 * 职责边界：本钩子**拥有** taskLaunchSessions / nodeSessionIds 两份状态——
 * 全部写点（初始装载、3s 轮询、task-instance-changed 事件、快照应用）都在
 * 簇内；chat-page 只消费返回值。任务图重载（active_run_id 变化检测）与
 * conductor 任务发现（无实例 + 有真实会话 id 时关联）经 ref/回调注入，
 * 本钩子不感知页面其余状态。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand } from "@/hooks/use-invoke";
import type { TaskLaunchInstanceSummary } from "@/features/task-instance/types";
import { logTaskPhaseDebug } from "@/features/task-instance/task-phase-debug";

/** 任务图操作的最小结构面（useTaskGraph 返回值的子集，结构性依赖）。 */
export interface TaskGraphSyncHandle {
  loadGraph(graphId: string): Promise<unknown>;
  displayedRunId: string | null;
}

export interface TaskInstanceSyncDeps {
  /** 项目根（空 = 清空并停止轮询）。 */
  projectPath: string | null;
  /** 项目根 ref（事件监听 effect 为 mount-only，读实时值）。 */
  projectPathRef: RefObject<string | null>;
  /** 任务图句柄 ref（轮询里检测 run 变化重载图；ref 防轮询回调重建死循环）。 */
  taskGraphRef: RefObject<TaskGraphSyncHandle>;
  /** 当前活跃任务 id ref。 */
  activeTaskInstanceIdRef: RefObject<string | null>;
  /** 上次见到的 active_run_id ref（conductor 重试建新 run 的变化检测）。 */
  lastInstanceRunIdRef: RefObject<string | null>;
  /** 最近真实会话 id ref（无实例时的事件关联发现）。 */
  lastRealSessionIdRef: RefObject<string | null>;
  /** conductor 任务发现（会话 → 任务实例关联）。经 ref 注入：页面侧该函数
   *  定义在本钩子之后（依赖本钩子的列表 setter），ref 在其定义后回填，
   *  mount-only 监听按事件时点读取，规避渲染期 TDZ。 */
  discoverConductorTaskRef: RefObject<(sessionId: string) => Promise<unknown>>;
  /** 快照命中当前任务时的身份落地（任务 id/需求文件/status——页面持 state）。 */
  activeTaskResolved?: (record: TaskLaunchInstanceSummary) => void;
}

export function useTaskInstanceSync(deps: TaskInstanceSyncDeps) {
  const {
    projectPath,
    projectPathRef,
    taskGraphRef,
    activeTaskInstanceIdRef,
    lastInstanceRunIdRef,
    lastRealSessionIdRef,
    discoverConductorTaskRef,
  } = deps;

  // 任务会话（需求/规划）与节点子代理会话 id（常规列表过滤用，同节奏刷新）。
  const [taskLaunchSessions, setTaskLaunchSessions] = useState<TaskLaunchInstanceSummary[]>([]);
  const [nodeSessionIds, setNodeSessionIds] = useState<string[]>([]);
  const activeTaskResolvedRef = useRef(deps.activeTaskResolved);
  activeTaskResolvedRef.current = deps.activeTaskResolved;

  const refreshTaskLaunchSessions = useCallback(async () => {
    if (!projectPath) {
      setTaskLaunchSessions([]);
      setNodeSessionIds([]);
      return;
    }
    try {
      const [items, nodeIds] = await Promise.all([
        invokeCommand<TaskLaunchInstanceSummary[]>(
          "task_launch_list_sessions",
          { projectRoot: projectPath },
        ),
        // 节点子代理会话 id（全局；orchestrator feature 关时命令不注册，降级为空）。
        invokeCommand<string[]>("orchestrator_list_node_session_ids").catch(
          () => [] as string[],
        ),
      ]);
      setTaskLaunchSessions(items);
      setNodeSessionIds(nodeIds);

      // v0.7.0：检测当前任务的 active_run_id 变化（conductor 重试创建新 run）。
      // 只在轮询回调里、且 run id 真正变化时 loadGraph，不会死循环。
      // 注意：通过 ref 读 taskGraph，避免把它放进依赖数组（它是每次渲染的新对象，
      // 会导致 useCallback 重建 → useEffect 重跑 → 死循环 → 界面一直加载中）。
      const tg = taskGraphRef.current;
      const activeInst = items.find((it) => it.task_id === activeTaskInstanceIdRef.current);
      const newRunId = activeInst?.active_run_id ?? null;
      if (
        newRunId
        && newRunId !== lastInstanceRunIdRef.current
        && activeInst?.graph_id
        && tg && tg.displayedRunId !== newRunId
      ) {
        lastInstanceRunIdRef.current = newRunId;
        tg.loadGraph(activeInst.graph_id).catch(console.error);
      }
    } catch (error) {
      console.warn("Failed to load task launch sessions:", error);
    }
  }, [projectPath, taskGraphRef, activeTaskInstanceIdRef, lastInstanceRunIdRef]);

  useEffect(() => {
    refreshTaskLaunchSessions().catch(console.error);
  }, [refreshTaskLaunchSessions]);

  useEffect(() => {
    if (!projectPath) return;
    const timer = window.setInterval(() => {
      refreshTaskLaunchSessions().catch(console.error);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [projectPath, refreshTaskLaunchSessions]);

  /** 流式管线快照应用：当前任务的身份/需求文件即时落地，列表去重置顶。 */
  const applyTaskLaunchInstanceSnapshot = useCallback((record: TaskLaunchInstanceSummary) => {
    const isCurrentTask = !activeTaskInstanceIdRef.current
      || activeTaskInstanceIdRef.current === record.task_id;

    logTaskPhaseDebug("snapshot:received", {
      taskId: record.task_id,
      isCurrentTask,
      status: record.status,
      currentPhase: record.current_phase,
    });

    if (isCurrentTask) {
      activeTaskInstanceIdRef.current = record.task_id;
      // 任务身份 state（id/需求文件/status）由页面在 activeTaskResolved 回调
      // 落地——本钩子只持有列表；经 ref 调用保持 applySnapshot 身份恒定。
      activeTaskResolvedRef.current?.(record);
    }

    setTaskLaunchSessions((current) => {
      const rest = current.filter((item) => item.task_id !== record.task_id);
      return [record, ...rest];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTaskInstanceIdRef]);

  // v0.9.2 需求6：任务实例变更事件（后端 conductor_sync_phase / mark_session 落库后
  // 广播）。两件事：① 即时刷新任务列表（不等 3s 轮询，阶段推进实时可见）；
  // ② 会话模式下关联当前会话对应的任务实例——原发现通道只有 session_resolved
  // 时 4.8s 轮询窗口，conductor 在完整回合后才建实例，窗口内必然 not-found，
  // 页面永远关联不上 → follow effect 无可观察对象、执行视图永不自动出现。
  useEffect(() => {
    const unlisten = listen<{ project_root: string; task_id: string; current_phase: string }>(
      "task-instance-changed",
      (event) => {
        const projectRoot = projectPathRef.current;
        if (!projectRoot || event.payload.project_root !== projectRoot) return;
        invokeCommand<TaskLaunchInstanceSummary[]>("task_launch_list_sessions", { projectRoot })
          .then((items) => {
            setTaskLaunchSessions(items);
            // v0.9.2 测试期（执行期方案调整）：活跃任务实例变更（含 conductor_revise_plan
            // 落新 revision）时重载任务图——方案卡/子任务卡/全景即时反映修订。
            const changedInst = items.find((item) => item.task_id === event.payload.task_id);
            if (
              changedInst?.current_phase === "execution" &&
              changedInst.graph_id &&
              changedInst.task_id === activeTaskInstanceIdRef.current
            ) {
              taskGraphRef.current.loadGraph(changedInst.graph_id).catch((e) =>
                console.warn("reload graph after instance change failed:", e),
              );
            }
            if (!activeTaskInstanceIdRef.current && lastRealSessionIdRef.current) {
              const sid = lastRealSessionIdRef.current;
              logTaskPhaseDebug("task-instance-changed:associate", {
                taskId: event.payload.task_id,
                sessionId: sid,
                currentPhase: event.payload.current_phase,
              });
              discoverConductorTaskRef.current?.(sid).catch((e) =>
                console.warn("discoverConductorTask failed:", e),
              );
            }
          })
          .catch((e) => console.warn("task-instance-changed refresh failed:", e));
      },
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    taskLaunchSessions,
    /** 列表直写（删除任务/重命名/发现轮询等页面侧存量消费点）。 */
    setTaskLaunchSessions,
    nodeSessionIds,
    refreshTaskLaunchSessions,
    applyTaskLaunchInstanceSnapshot,
  };
}
