/**
 * ExecutionStartPrompt —— 会话区「是否开始执行」确认卡。
 *
 * 设计依据：需求六「三段合流」+ 用户 2026-08-02 明确的执行阶段形态：
 *   「就应该在流程规划下面出现一个分隔线『流程执行』，右侧边栏出现几个步骤，
 *     会话区弹出是否开始执行；如果开始执行，流程就一步步执行；如果不开始执行，
 *     可以在会话区让主进程调整流程，也可以自己点击编排按钮进入流程画布进行调整。」
 *
 * 因此本卡片有且仅有两条出路：
 *   - 「开始执行」→ 启动 run，主区随即切为 run 事件流（同一条会话流内往下追加）。
 *   - 「先调整流程」→ 收起卡片，用户在下方输入框与任务助手对话，或点右侧「编排」进画布。
 *
 * 本组件是纯展示 + 回调，不持有任何请求逻辑（启动走 `startTaskRun`）。
 */
import { Play, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface ExecutionStartPromptProps {
  /** 流程步骤数（来自 graph snapshot），为 0 时说明流程尚未就绪。 */
  stepCount: number;
  /** 流程是否可启动（有 graph revision）。 */
  canStart: boolean;
  /** 启动请求进行中。 */
  starting?: boolean;
  /** 启动失败提示。 */
  error?: string | null;
  onStart: () => void;
  onDismiss: () => void;
}

export function ExecutionStartPrompt({
  stepCount,
  canStart,
  starting = false,
  error,
  onStart,
  onDismiss,
}: ExecutionStartPromptProps) {
  const { t } = useTranslation();

  return (
    <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4 py-2">
      <div className="rounded-xl border border-border bg-muted/60 p-4 colorful:border-emerald-200/70 colorful:bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/30">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground colorful:bg-emerald-500/15 colorful:text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">
              {t("task.execution.confirmTitle", "是否开始执行？")}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {stepCount > 0
                ? t("task.execution.confirmDesc", "流程共 {{count}} 个步骤，开始后将按依赖顺序依次执行。", {
                    count: stepCount,
                  })
                : t("task.execution.confirmDescEmpty", "流程尚未生成步骤，请先在下方对话中让任务助手补全流程。")}
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground/80">
              {t(
                "task.execution.confirmHint",
                "暂不执行也可以：在下方对话中让任务助手调整流程，或点击右侧「编排」进入流程画布手动调整。",
              )}
            </p>

            {error ? (
              <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-600 dark:text-red-300">
                {error}
              </div>
            ) : null}

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={onStart}
                disabled={!canStart || starting || stepCount === 0}
                className="flex h-7 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-[12px] font-medium text-white transition-fast hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-3 w-3" />
                {starting
                  ? t("task.execution.starting", "启动中…")
                  : t("task.execution.start", "开始执行")}
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="flex h-7 items-center rounded-md px-3 text-[12px] text-muted-foreground transition-fast hover:bg-accent hover:text-foreground"
              >
                {t("task.execution.adjustFirst", "先调整流程")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
