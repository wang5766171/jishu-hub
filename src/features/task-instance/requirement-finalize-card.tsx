/**
 * RequirementFinalizeCard —— 嵌入需求讨论会话流的需求定稿确认卡片。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §3.3。
 *           `任务数据结构与生命周期设计_20260622.md` §3.1（终稿由 skill 约束格式）。
 *
 * 展示 Agent 按 skill 产出的结构化定稿 markdown，提供"修改/确认"操作。
 * 只读模式下隐藏操作按钮。
 */
import { Check, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";

interface RequirementFinalizeCardProps {
  title: string;
  markdown: string;
  readOnly: boolean;
  onConfirm: () => void;
  onModify?: () => void;
}

export function RequirementFinalizeCard({
  title,
  markdown,
  readOnly,
  onConfirm,
  onModify,
}: RequirementFinalizeCardProps) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Check className="h-3 w-3" />
        </span>
        <span className="text-sm font-medium text-foreground">
          {t("task.requirements.finalize", "需求终稿")} · {title}
        </span>
      </div>

      <div className="max-h-60 overflow-y-auto rounded-md bg-background p-2 text-xs text-muted-foreground">
        <pre className="whitespace-pre-wrap break-words font-sans">{markdown}</pre>
      </div>

      {!readOnly && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {onModify && (
            <button
              type="button"
              onClick={onModify}
              className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Pencil className="h-3 w-3" />
              {t("common.modify", "修改")}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Check className="h-3 w-3" />
            {t("task.requirements.confirm", "确认无误，开始规划")}
          </button>
        </div>
      )}
    </div>
  );
}
