/**
 * PhasePlanningView —— 流程规划阶段视图。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §3.3、§6。
 *           `任务数据结构与生命周期设计_20260622.md` §3.2。
 *           `任务会话与流程串联补充说明_20260621.md` §6.3（规划阶段读取需求终稿）。
 *
 * 复用 PhaseConversationShell（会话核心），注入规划阶段专属的：
 *   - prepareMessage：注入 `<jishu-task-planning-stage>` + 需求终稿内容
 *   - 嵌入流程图生成确认卡片（用户确认 → 触发 orchestrator_create_graph + attach_graph）
 *   - onSessionResolved：回写 planning_session_id
 */
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PhaseConversationShell } from "./phase-conversation-shell";
import { GraphGenerationCard } from "./graph-generation-card";
import type { PreparedMessage } from "@/features/chat-core/types";
import type { TaskInstance } from "./types";

interface PhasePlanningViewProps {
  instance: TaskInstance | null;
  sessionId: string | null;
  readOnly: boolean;
  projectPath: string;
  encodedProjectId?: string;
  /** 用户确认生成流程图 → 触发 orchestrator_create_graph + attach_graph。 */
  onGenerateGraph: () => void;
  /** 用户要求修改方案 → 继续讨论。 */
  onModify?: () => void;
  /** 是否展示生成卡片（Agent 发起"是否生成流程图"交互后置为 true）。 */
  showGenerationCard: boolean;
}

export function PhasePlanningView({
  instance,
  sessionId,
  readOnly,
  projectPath,
  encodedProjectId,
  onGenerateGraph,
  onModify,
  showGenerationCard,
}: PhasePlanningViewProps) {
  const { t } = useTranslation();

  // 规划阶段的隐藏指令注入（含需求终稿路径，约束 Agent 基于终稿规划流程）。
  const prepareMessage = useCallback(
    (message: string): PreparedMessage => {
      const taskId = instance?.task_id ?? "";
      const skillId = instance?.skill_id ?? "jishu-task-planner";
      const reqFile = instance?.requirement_file ?? "";
      const hidden = `<jishu-task-planning-stage>
task_id: ${taskId}
requirement_file: ${reqFile}
skill_id: ${skillId}
当前处于流程规划阶段。请读取需求终稿，设计任务流程节点（明确职责、依赖、验收口径、人工确认点），与用户讨论调整。
不要执行任务代码或命令；不要要求用户去画布点击智能规划——规划在会话里完成。
当流程方案稳定后，请使用交互式问答（request_user_input）向用户确认是否生成任务流程图，选项中必须包含"确认生成任务流程图"。
用户确认后：说明"流程规划阶段完成，将生成任务流程图并进入执行阶段"，这是你在本阶段的最后一次回复——不要自己调用任何生成图的工具，系统会自动调用编排引擎生成流程图并推进到执行阶段。
</jishu-task-planning-stage>`;
      return { visible: message, agent: `${hidden}\n\n${message}` };
    },
    [instance?.task_id, instance?.skill_id, instance?.requirement_file],
  );

  const inputContextFooter = useMemo(
    () => (
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>{t("task.mode.planning", "流程规划")}</span>
        {instance?.skill_id && <span>· {instance.skill_id}</span>}
      </div>
    ),
    [instance?.skill_id, t],
  );

  return (
    <PhaseConversationShell
      sessionId={sessionId}
      phase="planning"
      readOnly={readOnly}
      projectPath={projectPath}
      encodedProjectId={encodedProjectId}
      prepareMessage={prepareMessage}
      inputContextFooter={inputContextFooter}
      embeddedCard={
        showGenerationCard ? (
          <GraphGenerationCard
            readOnly={readOnly}
            onConfirm={onGenerateGraph}
            onModify={onModify}
          />
        ) : null
      }
    />
  );
}
