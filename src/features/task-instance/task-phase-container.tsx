/**
 * TaskPhaseContainer —— 三阶段任务容器（React.lazy 入口）。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §3.1、§3.3、§2.4（三层引入关系）。
 *
 * 组装：useTaskInstance + useTaskGraph + useChatSession（通过 PhaseView）+ useRunEventStream
 * 渲染：TaskPhaseNavBar + 当前阶段的 PhaseView（requirements / planning / execution）
 *
 * 作为独立 chunk 动态加载，chat-page 通过 React.lazy 引入，不膨胀初始 bundle。
 */
import { useEffect } from "react";
import { useTaskGraph } from "@/features/task-instance/graph/use-task-graph";
import { TaskPhaseNavBar } from "./task-phase-nav-bar";
import { PhaseRequirementsView } from "./phase-requirements-view";
import { PhasePlanningView } from "./phase-planning-view";
import { PhaseExecutionView } from "./phase-execution-view";
import { logTaskPhaseDebug } from "./task-phase-debug";
import { useTaskInstance } from "./use-task-instance";
import type { TaskPhase } from "./types";

export interface TaskPhaseContainerProps {
  projectPath: string;
  encodedProjectId?: string;
  initialTaskId?: string | null;
  initialPhase?: TaskPhase;
  initialReadOnly?: boolean;
  agents?: Array<{ id: string; display_name: string }>;
  /** agents 是否仍在加载（用于区分「加载中」与「加载失败/为空」）。 */
  agentsLoading?: boolean;
  onSidebarUpdate?: () => void;
  onClose?: () => void;
}

export default function TaskPhaseContainer({
  projectPath,
  encodedProjectId,
  initialTaskId,
  initialPhase,
  initialReadOnly = false,
  agents,
  agentsLoading = false,
  onSidebarUpdate,
  onClose,
}: TaskPhaseContainerProps) {
  const task = useTaskInstance({ projectRoot: projectPath, initialTaskId });
  const taskGraph = useTaskGraph();

  // 进入时打开初始任务（若有）。
  useEffect(() => {
    logTaskPhaseDebug("container:init", {
      taskId: initialTaskId,
      initialPhase,
      initialReadOnly,
      projectRoot: projectPath,
    });
    if (initialTaskId) {
      task.openTask(initialTaskId);
    }
    if (initialPhase) {
      task.openPhase(initialPhase, initialReadOnly);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // activeInstance 变化时同步侧边栏列表。
  useEffect(() => {
    onSidebarUpdate?.();
  }, [task.activeInstanceId, task.activeInstance?.updated_at, onSidebarUpdate]);

  // 执行阶段：加载图数据。
  useEffect(() => {
    if (
      task.activePhase === "execution" &&
      task.activeInstance?.graph_id &&
      task.activeInstance.graph_id !== taskGraph.graph?.graph_id
    ) {
      logTaskPhaseDebug("container:load-graph", {
        taskId: task.activeInstance.task_id,
        graphId: task.activeInstance.graph_id,
        activePhase: task.activePhase,
        currentLoadedGraphId: taskGraph.graph?.graph_id ?? null,
      });
      taskGraph.loadGraph(task.activeInstance.graph_id).catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.activePhase, task.activeInstance?.graph_id]);

  // ── 会话解析回调：将 conductor 会话写回 TaskInstance 对应阶段字段 ──
  const handleSessionResolved = (realSessionId: string, phase: TaskPhase) => {
    logTaskPhaseDebug("container:session-resolved", {
      taskId: task.activeInstanceId,
      phase,
      sessionId: realSessionId,
    });
    task.markSession(realSessionId, phase).catch(console.error);
  };

  const runStatusLabel = task.activeInstance?.run_status ?? null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <TaskPhaseNavBar
        title={task.activeInstance?.title ?? null}
        phases={task.phaseStates}
        activePhase={task.activePhase}
        runStatusLabel={runStatusLabel}
        onPhaseChange={(phase) => {
          // done 阶段点击 → 回溯只读；active 阶段 → 回到当前
          const state = task.phaseStates[phase];
          logTaskPhaseDebug("container:phase-click", {
            taskId: task.activeInstanceId,
            requestedPhase: phase,
            state,
            activePhase: task.activePhase,
            readOnly: state === "done",
          });
          task.openPhase(phase, state === "done");
        }}
        onClose={onClose}
      />

      <div className="flex min-h-0 flex-1">
        {task.activePhase === "requirements" && (
          <PhaseRequirementsView
            instance={task.activeInstance}
            sessionId={task.activeInstance?.requirement_session_id ?? null}
            readOnly={task.readOnly}
            projectPath={projectPath}
            encodedProjectId={encodedProjectId}
            onSessionResolved={(sid) => handleSessionResolved(sid, "requirements")}
          />
        )}

        {task.activePhase === "planning" && (
          <PhasePlanningView
            instance={task.activeInstance}
            sessionId={task.activeInstance?.planning_session_id ?? null}
            readOnly={task.readOnly}
            projectPath={projectPath}
            encodedProjectId={encodedProjectId}
            onSessionResolved={(sid) => handleSessionResolved(sid, "planning")}
          />
        )}

        {task.activePhase === "execution" && task.activeInstance?.graph_id && (
          <PhaseExecutionView
            instance={task.activeInstance}
            projectPath={projectPath}
            encodedProjectId={encodedProjectId}
            taskGraph={taskGraph}
            readOnly={task.readOnly}
            executionView={task.executionView}
            chatScope={task.chatScope}
            selectedNodeId={task.selectedNodeId}
            nodeSessions={task.nodeSessionMap}
            agents={agents}
            agentsLoading={agentsLoading}
            onExecutionViewChange={task.setExecutionView}
            onChatScopeChange={task.setChatScope}
            onSelectNode={task.selectNode}
            onNodeSessionUpdate={task.updateNodeSession}
            onSyncRunStatus={task.syncRunStatus}
          />
        )}

        {task.activePhase === "execution" && !task.activeInstance?.graph_id && (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            任务尚未生成流程图
          </div>
        )}
      </div>
    </div>
  );
}
