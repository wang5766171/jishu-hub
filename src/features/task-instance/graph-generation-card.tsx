/**
 * GraphGenerationCard —— 嵌入规划会话流的流程图生成确认卡片。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §3.3。
 *           `任务数据结构与生命周期设计_20260622.md` §3.2（用户确认 → create_graph + attach_graph）。
 */
import { Check, GitBranch, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";

interface GraphGenerationCardProps {
  readOnly: boolean;
  onConfirm: () => void;
  onModify?: () => void;
}

export function GraphGenerationCard({
  readOnly,
  onConfirm,
  onModify,
}: GraphGenerationCardProps) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-primary">
          <GitBranch className="h-3 w-3" />
        </span>
        <span className="text-sm font-medium text-foreground">
          {t("task.planning.generate", "确认生成任务流程图")}
        </span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {t(
          "task.planning.generateHint",
          "将基于讨论的方案生成任务流程图，进入执行画布。",
        )}
      </p>
      {!readOnly && (
        <div className="flex items-center justify-end gap-2">
          {onModify && (
            <button
              type="button"
              onClick={onModify}
              className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Pencil className="h-3 w-3" />
              {t("task.planning.modifyPlan", "修改方案")}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Check className="h-3 w-3" />
            {t("task.planning.confirmGenerate", "确认生成")}
          </button>
        </div>
      )}
    </div>
  );
}
