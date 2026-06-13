import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type {
  ApprovalRequest,
  ArtifactRef,
  GraphRevision,
  TaskEvent,
} from "./use-task-graph";

interface RunInspectorProps {
  runId: string;
  events: TaskEvent[];
  approvals: ApprovalRequest[];
  artifacts: ArtifactRef[];
  revisions: GraphRevision[];
  currentRevisionId?: string | null;
  onResolveApproval: (approvalId: string, approved: boolean) => Promise<void>;
  onClose: () => void;
}

type InspectorTab = "events" | "approvals" | "artifacts" | "revisions";

export function RunInspector({
  runId,
  events,
  approvals,
  artifacts,
  revisions,
  currentRevisionId,
  onResolveApproval,
  onClose,
}: RunInspectorProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<InspectorTab>("events");

  return (
    <aside className="flex h-full w-96 shrink-0 flex-col border-l border-border bg-background">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("tasks.workbench.runInspector")}
          </div>
          <div className="mt-1 truncate font-mono text-xs">{runId}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("tasks.workbench.closeRunInspector")}
          title={t("tasks.workbench.closeRunInspector")}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-4 border-b border-border text-xs">
        {(["events", "approvals", "artifacts", "revisions"] as InspectorTab[]).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={`px-2 py-2 ${tab === item ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {t(`tasks.workbench.inspectorTabs.${item}`)}
            {item === "approvals" && approvals.length > 0 ? ` (${approvals.length})` : ""}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {tab === "events" && (
          <div className="space-y-2">
            {events.length === 0 && <EmptyState label={t("tasks.workbench.noEvents")} />}
            {events.slice(-200).reverse().map((event) => (
              <div key={event.event_id} className="rounded-md border border-border bg-card p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{event.event_type}</span>
                  <span className="font-mono text-muted-foreground">#{event.run_seq}</span>
                </div>
                <div className="mt-1 text-muted-foreground">{event.actor}</div>
                {event.payload && (
                  <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === "approvals" && (
          <div className="space-y-3">
            {approvals.length === 0 && <EmptyState label={t("tasks.workbench.noApprovals")} />}
            {approvals.map((approval) => (
              <div key={approval.approval_id} className="rounded-md border border-purple-500/40 bg-card p-3 text-xs">
                <div className="font-medium">{approval.description}</div>
                <div className="mt-1 text-muted-foreground">
                  {approval.risk_level} · {approval.scope.join(", ")}
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    className="rounded bg-green-600 px-3 py-1.5 text-white hover:bg-green-700"
                    onClick={() => onResolveApproval(approval.approval_id, true)}
                  >
                    {t("tasks.workbench.approve")}
                  </button>
                  <button
                    type="button"
                    className="rounded bg-red-600 px-3 py-1.5 text-white hover:bg-red-700"
                    onClick={() => onResolveApproval(approval.approval_id, false)}
                  >
                    {t("tasks.workbench.reject")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "artifacts" && (
          <div className="space-y-2">
            {artifacts.length === 0 && <EmptyState label={t("tasks.workbench.noArtifacts")} />}
            {artifacts.map((artifact) => (
              <div key={artifact.artifact_id} className="rounded-md border border-border bg-card p-3 text-xs">
                <div className="font-medium">{artifact.name}</div>
                <div className="mt-1 text-muted-foreground">{artifact.artifact_type}</div>
                <div className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
                  {artifact.hash}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "revisions" && (
          <div className="space-y-2">
            {revisions.slice().reverse().map((revision) => (
              <div
                key={revision.revision_id}
                className={`rounded-md border p-3 text-xs ${
                  revision.revision_id === currentRevisionId
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono">{revision.revision_id}</span>
                  {revision.revision_id === currentRevisionId && (
                    <span className="rounded bg-primary px-1.5 py-0.5 text-primary-foreground">
                      {t("tasks.workbench.currentRevision")}
                    </span>
                  )}
                </div>
                <div className="mt-2 text-muted-foreground">{revision.change_summary || revision.author}</div>
                <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                  {revision.content_hash}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="py-8 text-center text-xs text-muted-foreground">{label}</div>;
}
