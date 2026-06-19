import { useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { Box, FileText, ListChecks, MessageSquareText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getInterventionModeForStatus } from "./contracts";
import type {
  ApprovalRequest,
  ArtifactRef,
  GraphNode,
  NodeRun,
  TaskEvent,
} from "./use-task-graph";

type InspectorTab = "overview" | "run" | "conversation" | "artifacts";

interface InspectorPanelProps {
  node: GraphNode | null;
  nodeRun?: NodeRun | null;
  events?: TaskEvent[];
  approvals?: ApprovalRequest[];
  artifacts?: ArtifactRef[];
  onChooseRecovery?: (
    nodeRunId: string,
    strategy: "retry_now" | "skip_node" | "fail_node",
    reason: string,
  ) => Promise<unknown>;
  onResolveApproval?: (approvalId: string, approved: boolean) => Promise<void>;
  onClose: () => void;
}

export function InspectorPanel({
  node,
  nodeRun,
  events = [],
  approvals = [],
  artifacts = [],
  onChooseRecovery,
  onResolveApproval,
  onClose,
}: InspectorPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<InspectorTab>("overview");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  if (!node) return null;

  const tabs: Array<{
    id: InspectorTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: "overview", label: t("tasks.workbench.unifiedInspector.tabs.overview"), icon: ListChecks },
    { id: "run", label: t("tasks.workbench.unifiedInspector.tabs.run"), icon: FileText },
    { id: "conversation", label: t("tasks.workbench.unifiedInspector.tabs.conversation"), icon: MessageSquareText },
    { id: "artifacts", label: t("tasks.workbench.unifiedInspector.tabs.artifacts"), icon: Box },
  ];

  return (
    <aside className="flex h-full w-[22rem] shrink-0 flex-col border-l border-border bg-background">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("tasks.workbench.unifiedInspector.title")}
          </div>
          <div className="mt-1 truncate text-sm font-semibold">{node.title}</div>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={onClose}
          aria-label={t("tasks.workbench.closeNodeInspector")}
          title={t("tasks.workbench.closeNodeInspector")}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="grid grid-cols-4 border-b border-border text-xs">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                "flex min-h-12 flex-col items-center justify-center gap-1 px-1 py-2 transition",
                tab === item.id
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
        {tab === "overview" && (
          <div className="space-y-4">
            <Field label={t("tasks.workbench.nodeId")} value={node.node_id} />
            <Field
              label={t("tasks.workbench.nodeKind")}
              value={t(`tasks.workbench.nodeKinds.${node.node_kind}`)}
            />
            {node.description && (
              <Field label={t("tasks.workbench.description")} value={node.description} />
            )}
            <JsonBlock label={t("tasks.workbench.input")} value={node.input_contract} />
            <JsonBlock label={t("tasks.workbench.output")} value={node.output_contract} />
          </div>
        )}
        {tab === "run" && (
          <RunTab
            node={node}
            nodeRun={nodeRun}
            approvals={approvals}
            busyAction={busyAction}
            onChooseRecovery={onChooseRecovery}
            onResolveApproval={onResolveApproval}
            onBusyActionChange={setBusyAction}
          />
        )}
        {tab === "conversation" && (
          <EventList events={events} />
        )}
        {tab === "artifacts" && (
          <ArtifactList artifacts={artifacts} />
        )}
      </div>
    </aside>
  );
}

function RunTab({
  node,
  nodeRun,
  approvals,
  busyAction,
  onChooseRecovery,
  onResolveApproval,
  onBusyActionChange,
}: {
  node: GraphNode;
  nodeRun?: NodeRun | null;
  approvals: ApprovalRequest[];
  busyAction: string | null;
  onChooseRecovery?: (
    nodeRunId: string,
    strategy: "retry_now" | "skip_node" | "fail_node",
    reason: string,
  ) => Promise<unknown>;
  onResolveApproval?: (approvalId: string, approved: boolean) => Promise<void>;
  onBusyActionChange: (value: string | null) => void;
}) {
  const { t } = useTranslation();
  if (!nodeRun) {
    return <EmptyState label={t("tasks.workbench.intervention.noNodeRun")} />;
  }

  const mode = getInterventionModeForStatus(nodeRun.status);
  const recover = async (strategy: "retry_now" | "skip_node" | "fail_node") => {
    if (!onChooseRecovery) return;
    onBusyActionChange(strategy);
    try {
      await onChooseRecovery(
        nodeRun.node_run_id,
        strategy,
        `${t("tasks.workbench.intervention.manualReason")} ${node.title}`,
      );
    } finally {
      onBusyActionChange(null);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {t("tasks.workbench.intervention.status")}
          </span>
          <span className="rounded bg-muted px-2 py-1 text-xs font-medium">
            {t(`tasks.workbench.status.${nodeRun.status}`)}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <Field
            label={t("tasks.workbench.intervention.nodeRun")}
            value={nodeRun.node_run_id}
          />
          <Field
            label={t("tasks.workbench.intervention.attempts")}
            value={String(nodeRun.attempt_count)}
          />
        </div>
        {nodeRun.error && (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            {nodeRun.error}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-3">
        <div className="text-xs font-medium text-muted-foreground">
          {t("tasks.workbench.intervention.title")}
        </div>
        <div className="mt-2 text-sm">
          {t(`tasks.workbench.intervention.modes.${mode}`)}
        </div>
        {mode === "recovery" || mode === "retry_wait" ? (
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!onChooseRecovery || !!busyAction}
              onClick={() => recover("retry_now").catch(console.error)}
            >
              {t("tasks.workbench.intervention.retryNow")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!onChooseRecovery || !!busyAction}
              onClick={() => recover("skip_node").catch(console.error)}
            >
              {t("tasks.workbench.intervention.skipNode")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!onChooseRecovery || !!busyAction}
              onClick={() => recover("fail_node").catch(console.error)}
            >
              {t("tasks.workbench.intervention.failNode")}
            </Button>
          </div>
        ) : null}
      </section>

      {approvals.map((approval) => (
        <section
          key={approval.approval_id}
          className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-3"
        >
          <div className="text-xs font-medium text-amber-700 dark:text-amber-300">
            {t("tasks.workbench.intervention.approvalCard")}
          </div>
          <div className="mt-2 text-sm">{approval.description}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {approval.risk_level} / {approval.scope.join(", ")}
          </div>
          {!approval.resolved && onResolveApproval && (
            <div className="mt-3 flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => onResolveApproval(approval.approval_id, true)}
              >
                {t("tasks.workbench.approve")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onResolveApproval(approval.approval_id, false)}
              >
                {t("tasks.workbench.reject")}
              </Button>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function EventList({ events }: { events: TaskEvent[] }) {
  const { t } = useTranslation();
  if (events.length === 0) {
    return <EmptyState label={t("tasks.workbench.noEvents")} />;
  }
  return (
    <div className="space-y-2">
      {events.slice(-100).reverse().map((event) => (
        <div key={event.event_id} className="rounded-lg border border-border bg-card p-3 text-xs">
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
  );
}

function ArtifactList({ artifacts }: { artifacts: ArtifactRef[] }) {
  const { t } = useTranslation();
  if (artifacts.length === 0) {
    return <EmptyState label={t("tasks.workbench.noArtifacts")} />;
  }
  return (
    <div className="space-y-2">
      {artifacts.map((artifact) => (
        <div key={artifact.artifact_id} className="rounded-lg border border-border bg-card p-3 text-xs">
          <div className="font-medium">{artifact.name}</div>
          <div className="mt-1 text-muted-foreground">{artifact.artifact_type}</div>
          <div className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
            {artifact.hash}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-foreground">{value}</div>
    </div>
  );
}

function JsonBlock({
  label,
  value,
}: {
  label: string;
  value: Record<string, unknown>;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <pre className="mt-1 max-h-36 overflow-auto rounded-md bg-muted p-2 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
