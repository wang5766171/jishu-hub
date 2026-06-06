import { Badge } from "@/components/ui/badge";
import { t } from "i18next";
import { RunSummary, RunRecord } from "@/pages/tasks-page";

export function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "complete") return "default";
  if (status === "aborted") return "outline";
  if (status === "error") return "destructive";
  return "secondary";
}

export function translateStatus(status: string) {
  return t(`tasks.status.${status}`, { defaultValue: status });
}

interface TaskRunsListProps {
  runs: RunSummary[];
  loading: boolean;
  selectedRun: RunRecord | null;
  loadRun: (runId: string) => void;
  onContextMenu: (e: React.MouseEvent, runId: string) => void;
}

export function TaskRunsList({ runs, loading, selectedRun, loadRun, onContextMenu }: TaskRunsListProps) {
  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t("tasks.runs")}</h3>
        <Badge variant="secondary">{runs.length}</Badge>
      </div>
      <div className="space-y-2">
        {runs.length === 0 ? (
          <div className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">
            {loading ? t("tasks.loadingRuns") : t("tasks.noRuns")}
          </div>
        ) : (
          runs.slice(0, 12).map((run) => (
            <button
              key={run.run_id}
              onClick={() => loadRun(run.run_id)}
              onContextMenu={(e) => onContextMenu(e, run.run_id)}
              className={`w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent/40 ${
                selectedRun?.run_id === run.run_id
                  ? "bg-accent/60 border-primary"
                  : "bg-background/60"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{run.title || run.task_id}</span>
                <Badge variant={statusVariant(run.status)}>{translateStatus(run.status)}</Badge>
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground">{run.run_id}</div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
