/**
 * PhaseRequirementsView —— 需求讨论阶段视图。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §3.3、§6。
 *           `任务数据结构与生命周期设计_20260622.md` §3.1。
 *           `任务会话与流程串联补充说明_20260621.md` §5.3（需求讨论阶段 skill 约束隐藏注入）。
 *
 * 复用 PhaseConversationShell（会话核心），注入需求讨论专属的：
 *   - prepareMessage：注入 `<jishu-task-requirements-stage>` 隐藏指令（约束 Agent 只做需求澄清）
 *   - 嵌入需求定稿确认卡片（Agent 发起"是否生成流程图"交互后展示）
 *   - onSessionResolved：回写 requirement_session_id
 */
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PhaseConversationShell } from "./phase-conversation-shell";
import { RequirementFinalizeCard } from "./requirement-finalize-card";
import type { PreparedMessage } from "@/features/chat-core/types";
import type { TaskInstance } from "./types";

interface PhaseRequirementsViewProps {
  instance: TaskInstance | null;
  sessionId: string | null;
  readOnly: boolean;
  projectPath: string;
  encodedProjectId?: string;
  /** Agent 产出的结构化定稿（由 skill 约束格式）。null 时不显示定稿卡。 */
  finalizeCardData: { taskId: string; title: string; requirementMarkdown: string } | null;
  onSessionResolved?: (realSessionId: string) => void;
  /** 用户确认需求定稿 → 触发 finalizeRequirements。 */
  onFinalize: (markdown: string) => void;
  /** 用户要求修改 → 继续讨论（卡片收起）。 */
  onModify?: () => void;
}

export function PhaseRequirementsView({
  instance,
  sessionId,
  readOnly,
  projectPath,
  encodedProjectId,
  finalizeCardData,
  onSessionResolved,
  onFinalize,
  onModify,
}: PhaseRequirementsViewProps) {
  const { t } = useTranslation();

  // 需求讨论阶段的隐藏指令注入（约束 Agent 只做需求澄清，不做实施/不建图）。
  const prepareMessage = useCallback(
    (message: string): PreparedMessage => {
      const skillId = instance?.skill_id ?? "jishu-task-planner";
      const hidden = `<jishu-task-launch-instruction>
skill_id: ${skillId}
当前处于需求讨论阶段。你的职责是通过多轮对话澄清需求，不要写代码、不要执行命令、不要输出任务流程图或执行计划。
当你判断需求已经足够明确时，请使用交互式问答（request_user_input）向用户确认是否进入流程规划阶段，选项中必须包含"生成任务流程图"。
用户选择"生成任务流程图"后：请在本轮回复中产出结构化的需求终稿（按技能方法论定义的格式：目标/范围/范围外/约束/验收标准/关键假设），并说明"需求讨论阶段完成，将进入流程规划阶段"。这是你在本阶段的最后一次回复——不要继续提问，不要自己生成流程图，系统会自动推进到下一阶段。
</jishu-task-launch-instruction>`;
      return { visible: message, agent: `${hidden}\n\n${message}` };
    },
    [instance?.skill_id],
  );

  const inputContextFooter = useMemo(
    () => (
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>{t("task.mode.requirements", "需求讨论")}</span>
        {instance?.skill_id && <span>· {instance.skill_id}</span>}
      </div>
    ),
    [instance?.skill_id, t],
  );

  return (
    <PhaseConversationShell
      sessionId={sessionId}
      phase="requirements"
      readOnly={readOnly}
      projectPath={projectPath}
      encodedProjectId={encodedProjectId}
      prepareMessage={prepareMessage}
      onSessionResolved={onSessionResolved}
      inputContextFooter={inputContextFooter}
      embeddedCard={
        finalizeCardData ? (
          <RequirementFinalizeCard
            title={finalizeCardData.title}
            markdown={finalizeCardData.requirementMarkdown}
            readOnly={readOnly}
            onConfirm={() => onFinalize(finalizeCardData.requirementMarkdown)}
            onModify={onModify}
          />
        ) : null
      }
    />
  );
}
