import { Check, LoaderCircle, LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PlanningProgress } from "./use-task-graph";

interface PlanningProgressOverlayProps {
  progress: PlanningProgress;
  text?: string;
}

export function PlanningProgressOverlay({
  progress,
  text,
}: PlanningProgressOverlayProps) {
  const { t } = useTranslation();
  const stages: PlanningProgress["stage"][] = [
    "preparing_context",
    "resolving_agent",
    "generating",
    "awaiting_input",
    "validating",
    "retrying",
    "building_proposal",
    "completed",
  ];
  const activeIndex = Math.max(0, stages.indexOf(progress.stage));

  return (
    <div
      role="status"
      aria-live="polite"
      aria-labelledby="task-planning-title"
      className="absolute inset-0 z-50 flex bg-background"
    >
      <aside className="w-72 shrink-0 border-r border-border/70 bg-card px-5 py-6">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          {t("tasks.workbench.planningProgress.eyebrow")}
        </div>
        <div className="mt-6 space-y-1">
          {stages.map((stage, index) => {
            const active = stage === progress.stage;
            const completed = index < activeIndex || progress.stage === "completed";
            return (
              <div
                key={stage}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-xs ${
                  active
                    ? "bg-primary/10 font-medium text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                <span className={`grid size-5 place-items-center rounded-full border ${
                  active || completed ? "border-primary/50 text-primary" : "border-border"
                }`}>
                  {completed ? (
                    <Check className="size-3" />
                  ) : active ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span>{t(`tasks.workbench.planningProgress.stages.${stage}`)}</span>
              </div>
            );
          })}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="h-1 overflow-hidden bg-muted">
          <div className="h-full w-full animate-pulse bg-primary" />
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center p-10">
          <div className="w-full max-w-2xl">
            <div className="flex items-start gap-4">
              <div className="rounded-2xl border border-primary/20 bg-primary/10 p-4 text-primary">
                <LoaderCircle className="size-7 animate-spin" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                  {t("tasks.workbench.planningProgress.live")}
                </p>
                <h2 id="task-planning-title" className="mt-2 text-2xl font-semibold text-foreground">
                  {t(`tasks.workbench.planningProgress.stages.${progress.stage}`)}
                </h2>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">
                  {t("tasks.workbench.planningProgress.description")}
                </p>
              </div>
            </div>

            <div className="mt-8 flex items-center justify-between rounded-xl border border-border/70 bg-card px-4 py-3 text-sm">
              <span className="flex items-center gap-2 text-muted-foreground">
                <LockKeyhole className="size-4 text-amber-500" />
              {t("tasks.workbench.planningProgress.locked")}
              </span>
              {progress.attempt && progress.max_attempts ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {t("tasks.workbench.planningProgress.attempt", {
                    current: progress.attempt,
                    total: progress.max_attempts,
                  })}
                </span>
              ) : null}
            </div>

            {text && text.trim() && (
              <div className="mt-6 max-h-[40vh] overflow-y-auto rounded-xl border border-border/70 bg-card p-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("tasks.workbench.planningProgress.agentOutput")}
                </p>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">
                  {text}
                </pre>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
