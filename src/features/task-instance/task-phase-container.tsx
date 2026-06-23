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
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTaskGraph } from "@/features/task-workbench/use-task-graph";
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
  onSidebarUpdate?: () => void;
  onClose?: () => void;
}

export default function TaskPhaseContainer({
  projectPath,
  encodedProjectId,
  initialTaskId,
  initialPhase,
  initialReadOnly = false,
  onSidebarUpdate,
  onClose,
}: TaskPhaseContainerProps) {
  const { t } = useTranslation();
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

  // ── 需求定稿状态（简化：本地 state 控制卡片显示）──
  const [showFinalizeCard, setShowFinalizeCard] = useState(false);
  const [showGenerationCard, setShowGenerationCard] = useState(false);

  const handleSessionResolved = (realSessionId: string, phase: TaskPhase) => {
    logTaskPhaseDebug("container:session-resolved", {
      taskId: task.activeInstanceId,
      phase,
      sessionId: realSessionId,
    });
    task.markSession(realSessionId, phase).catch(console.error);
  };

  const handleFinalize = async (markdown: string) => {
    if (!task.activeInstance) return;
    const result = await task.finalizeRequirements({
      task_id: task.activeInstanceId,
      skill_id: task.activeInstance.skill_id,
      title: task.activeInstance.title,
      requirement_markdown: markdown,
      source_session_id: task.activeInstance.requirement_session_id,
      creation_mode: "discussion",
    });
    if (result) {
      setShowFinalizeCard(false);
      // 终稿后自动进入规划阶段
      task.openPhase("planning");
    }
  };

  const handleGenerateGraph = async () => {
    if (!task.activeInstance) return;
    // 触发规划会话收集 → create_graph（复用现有 useTaskGraph.createGraph）
    await taskGraph.createGraph(
      task.activeInstance.title,
      task.activeInstance.requirement_file
        ? `需求终稿：${task.activeInstance.requirement_file}`
        : task.activeInstance.title,
      projectPath,
      [{ skill_id: task.activeInstance.skill_id }],
    );
    if (taskGraph.graph) {
      await task.attachGraph(taskGraph.graph.graph_id);
    }
    setShowGenerationCard(false);
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
            finalizeCardData={
              showFinalizeCard && task.activeInstance
                ? {
                    taskId: task.activeInstance.task_id,
                    title: task.activeInstance.title,
                    requirementMarkdown: t("task.requirements.finalizePlaceholder", "请确认需求终稿内容（由 Agent 按 skill 约束产出）。"),
                  }
                : null
            }
            onSessionResolved={(sid) => handleSessionResolved(sid, "requirements")}
            onFinalize={handleFinalize}
            onModify={() => setShowFinalizeCard(false)}
          />
        )}

        {task.activePhase === "planning" && (
          <PhasePlanningView
            instance={task.activeInstance}
            sessionId={task.activeInstance?.planning_session_id ?? null}
            readOnly={task.readOnly}
            projectPath={projectPath}
            encodedProjectId={encodedProjectId}
            showGenerationCard={showGenerationCard}
            onGenerateGraph={handleGenerateGraph}
            onModify={() => setShowGenerationCard(false)}
          />
        )}

        {task.activePhase === "execution" && task.activeInstance?.graph_id && (
          <PhaseExecutionView
            instance={task.activeInstance}
            projectPath={projectPath}
            encodedProjectId={encodedProjectId}
            taskGraph={taskGraph}
            executionView={task.executionView}
            chatScope={task.chatScope}
            selectedNodeId={task.selectedNodeId}
            nodeSessions={task.nodeSessionMap}
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
