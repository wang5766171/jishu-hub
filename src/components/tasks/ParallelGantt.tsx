import { t } from "i18next";

export interface StepOutcome {
  step_id: string;
  role_id: string;
  agent_id: string;
  agent_display_name?: string | null;
  status: "running" | "complete" | "failed" | "skipped" | "awaiting_approval";
  output?: unknown;
  session_id?: string | null;
  started_at: number;
  finished_at: number;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
}

function formatTime(value?: number | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

/**
 * Simple parallel Gantt chart for visualizing multi-step, multi-role execution.
 * Each row is a role; horizontal bars show each step's start/duration.
 * Steps without started_at/finished_at are shown as pending.
 */
export function ParallelGantt({
  steps,
  runStartedAt,
}: {
  steps: StepOutcome[];
  runStartedAt: number;
}) {
  // Group steps by role, preserving order
  const roleOrder: string[] = [];
  const byRole: Record<string, StepOutcome[]> = {};
  for (const step of steps) {
    const role = step.role_id || "default";
    if (!byRole[role]) {
      byRole[role] = [];
      roleOrder.push(role);
    }
    byRole[role].push(step);
  }

  // Time bounds
  const minTime = Math.min(
    runStartedAt,
    ...steps.map((s) => s.started_at || runStartedAt)
  );
  const maxTime = Math.max(
    runStartedAt + 1,
    ...steps.map((s) => s.finished_at || s.started_at || runStartedAt + 1)
  );
  const totalMs = Math.max(1, maxTime - minTime);

  const roleColor: Record<string, string> = {};
  const palette = [
    "bg-blue-500",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-purple-500",
    "bg-pink-500",
    "bg-cyan-500",
  ];
  roleOrder.forEach((role, i) => {
    roleColor[role] = palette[i % palette.length];
  });

  if (steps.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
        {t("tasks.noPlanSteps")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {roleOrder.map((role) => {
        const roleSteps = byRole[role];
        return (
          <div key={role} className="space-y-1">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${roleColor[role]}`} />
              <span className="text-xs font-medium">{role}</span>
              <span className="text-[10px] text-muted-foreground">({roleSteps.length} ²½)</span>
            </div>
            <div className="relative h-7 rounded bg-muted/30">
              {/* time gridlines every 25% */}
              {[0.25, 0.5, 0.75].map((p) => (
                <div
                  key={p}
                  className="absolute top-0 h-full w-px bg-border/50"
                  style={{ left: `${p * 100}%` }}
                />
              ))}
              {roleSteps.map((step, idx) => {
                const startMs = step.started_at || minTime;
                const endMs = step.finished_at || startMs + 1000;
                const leftPct = ((startMs - minTime) / totalMs) * 100;
                const widthPct = Math.max(2, ((endMs - startMs) / totalMs) * 100);
                const colorClass =
                  step.status === "complete"
                    ? roleColor[role]
                    : step.status === "failed"
                    ? "bg-red-500"
                    : "bg-muted-foreground/50";
                return (
                  <div
                    key={step.step_id}
                    className={`absolute top-1 h-5 rounded ${colorClass} flex items-center justify-center text-[10px] font-medium text-white shadow-sm`}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    title={`${step.agent_display_name || step.agent_id} ¡¤ ${step.role_id} ¡¤ ${formatTime(startMs)} ¡ú ${formatTime(endMs)}`}
                  >
                    {widthPct > 12 && <span className="truncate px-1">{idx + 1}. {step.agent_display_name || step.agent_id}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{formatTime(minTime)}</span>
        <span>{formatTime(maxTime)}</span>
      </div>
    </div>
  );
}
