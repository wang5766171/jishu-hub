import { LoaderCircle, LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PlanningProgress } from "./use-task-graph";

interface PlanningProgressOverlayProps {
  progress: PlanningProgress;
}

export function PlanningProgressOverlay({
  progress,
}: PlanningProgressOverlayProps) {
  const { t } = useTranslation();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-planning-title"
      className="absolute inset-0 z-50 grid place-items-center bg-slate-950/85 p-6 backdrop-blur-md"
    >
      <section className="w-full max-w-xl overflow-hidden rounded-2xl border border-cyan-300/25 bg-slate-950 shadow-2xl shadow-cyan-950/70">
        <div className="h-1 overflow-hidden bg-slate-800">
          <div className="h-full w-full animate-pulse bg-cyan-300" />
        </div>
        <div className="p-7">
          <div className="flex items-start gap-4">
            <div className="rounded-xl border border-cyan-300/25 bg-cyan-300/10 p-3 text-cyan-200">
              <LoaderCircle className="size-6 animate-spin" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
                {t("tasks.workbench.planningProgress.eyebrow")}
              </div>
              <h2 id="task-planning-title" className="mt-2 text-xl font-semibold text-slate-50">
                {t(`tasks.workbench.planningProgress.stages.${progress.stage}`)}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                {t("tasks.workbench.planningProgress.description")}
              </p>
            </div>
          </div>

          <div className="mt-6 flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/75 px-4 py-3 text-sm">
            <span className="flex items-center gap-2 text-slate-300">
              <LockKeyhole className="size-4 text-amber-300" />
              {t("tasks.workbench.planningProgress.locked")}
            </span>
            {progress.attempt && progress.max_attempts ? (
              <span className="font-mono text-xs text-slate-400">
                {t("tasks.workbench.planningProgress.attempt", {
                  current: progress.attempt,
                  total: progress.max_attempts,
                })}
              </span>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
