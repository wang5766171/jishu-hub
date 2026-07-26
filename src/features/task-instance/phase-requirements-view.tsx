/**
 * PhaseRequirementsView —— 需求讨论阶段视图（conductor 驱动）。
 *
 * 设计依据：Batch 2 UI 任务模式统一。需求讨论由 conductor 扩展驱动，
 * 本视图仅承载 conductor 会话（PhaseConversationShell），不再注入旧阶段推进话术，
 * 也不再使用原生定稿卡片。conductor 的 lock_requirement 确认卡通过 ctx.ui.select
 * 渲染为聊天交互卡（pendingInteractions），由 PhaseConversationShell 的 ChatInput 呈现。
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PhaseConversationShell } from "./phase-conversation-shell";
import type { TaskInstance } from "./types";

interface PhaseRequirementsViewProps {
  instance: TaskInstance | null;
  sessionId: string | null;
  readOnly: boolean;
  projectPath: string;
  encodedProjectId?: string;
  onSessionResolved?: (realSessionId: string) => void;
  onTurnComplete?: () => void;
}

export function PhaseRequirementsView({
  instance,
  sessionId,
  readOnly,
  projectPath,
  encodedProjectId,
  onSessionResolved,
  onTurnComplete,
}: PhaseRequirementsViewProps) {
  const { t } = useTranslation();

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
      onSessionResolved={onSessionResolved}
      onTurnComplete={onTurnComplete}
      inputContextFooter={inputContextFooter}
    />
  );
}
