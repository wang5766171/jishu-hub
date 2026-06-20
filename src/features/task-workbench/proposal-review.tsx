import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GraphCommand, GraphProposal } from "./use-task-graph";

interface ProposalReviewProps {
  proposal: GraphProposal;
  accepting: boolean;
  onAccept: (commandIds: string[]) => Promise<void>;
  onDismiss: () => void;
  className?: string;
}

export function ProposalReview({
  proposal,
  accepting,
  onAccept,
  onDismiss,
  className,
}: ProposalReviewProps) {
  const { t } = useTranslation();
  const diff = proposal.diff;
  // §12.5: accept all OR part of the proposal. Every command is selected by
  // default; the user unchecks the ones they want to defer.
  const allCommandIds = proposal.commands.map((command) => command.command_id);
  const [selectedIds, setSelectedIds] = useState<string[]>(allCommandIds);
  useEffect(() => {
    setSelectedIds(proposal.commands.map((command) => command.command_id));
  }, [proposal.proposal_id, proposal.commands]);
  const toggleCommand = (commandId: string) => {
    setSelectedIds((current) =>
      current.includes(commandId)
        ? current.filter((id) => id !== commandId)
        : [...current, commandId],
    );
  };
  const allSelected = selectedIds.length === allCommandIds.length && allCommandIds.length > 0;
  const toggleAll = () => setSelectedIds(allSelected ? [] : allCommandIds);

  return (
    <section className={`rounded-xl border border-primary/20 bg-background p-4 shadow-sm ${className ?? ""}`}>
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              {t("tasks.workbench.proposalEyebrow")}
            </div>
            <h2 className="mt-2 text-lg font-semibold text-foreground">
              {t("tasks.workbench.proposalTitle")}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{proposal.rationale}</p>
          </div>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
            onClick={onDismiss}
          >
            {t("common.cancel")}
          </button>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <DiffMetric label={t("tasks.workbench.nodesAdded")} value={diff.nodes_added.length} />
          <DiffMetric label={t("tasks.workbench.nodesChanged")} value={diff.nodes_updated.length} />
          <DiffMetric label={t("tasks.workbench.edgesAdded")} value={diff.edges_added.length} />
          <DiffMetric label={t("tasks.workbench.policyChanges")} value={diff.policy_changes.length} />
        </div>

        {proposal.expected_benefits.length > 0 && (
          <ProposalList
            title={t("tasks.workbench.expectedBenefits")}
            items={proposal.expected_benefits}
            tone="benefit"
          />
        )}
        {proposal.risks.length > 0 && (
          <ProposalList
            title={t("tasks.workbench.proposalRisks")}
            items={proposal.risks}
            tone="risk"
          />
        )}
        {proposal.warnings.length > 0 && (
          <ProposalList
            title={t("tasks.workbench.validationWarnings")}
            items={proposal.warnings}
            tone="warning"
          />
        )}

        <div className="mt-6">
          <h3 className="text-sm font-semibold text-foreground">
            {t("tasks.workbench.proposedNodes")}
          </h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {diff.nodes_added.map((nodeId) => (
              <span
                key={nodeId}
                className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs text-primary"
              >
                {nodeId}
              </span>
            ))}
          </div>
        </div>

        {proposal.commands.length > 0 && (
          <div className="mt-6">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">
                {t("tasks.workbench.proposalCommands")}
              </h3>
              <button
                type="button"
                className="text-xs text-primary hover:text-primary/80"
                onClick={toggleAll}
              >
                {allSelected
                  ? t("tasks.workbench.clearSelection")
                  : t("tasks.workbench.selectAll")}
              </button>
            </div>
            <ul className="mt-3 space-y-1.5">
              {proposal.commands.map((command) => {
                const checked = selectedIds.includes(command.command_id);
                return (
                  <li key={command.command_id}>
                    <label className="flex items-start gap-2.5 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground hover:border-primary/30">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCommand(command.command_id)}
                        className="mt-0.5"
                      />
                      <span>{summarizeCommand(command)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="mt-7 flex justify-end gap-3 border-t border-border pt-5">
          <button
            type="button"
            className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-muted"
            onClick={onDismiss}
          >
            {t("tasks.workbench.rejectProposal")}
          </button>
          <button
            type="button"
            disabled={accepting || selectedIds.length === 0}
            className="rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => onAccept(selectedIds).catch(console.error)}
          >
            {accepting
              ? t("tasks.workbench.acceptingProposal")
              : t("tasks.workbench.acceptProposal")}
          </button>
        </div>
      </section>
  );
}

function DiffMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="text-2xl font-semibold text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function ProposalList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "benefit" | "risk" | "warning";
}) {
  const toneClass =
    tone === "benefit"
      ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-200"
      : tone === "risk"
        ? "border-rose-500/20 bg-rose-500/5 text-rose-700 dark:text-rose-200"
        : "border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-200";
  return (
    <div className={`mt-5 rounded-lg border p-4 ${toneClass}`}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="mt-2 space-y-1 text-sm leading-6">
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>- {item}</li>
        ))}
      </ul>
    </div>
  );
}

/// Render a one-line, user-readable summary of a GraphCommand for the per-command
/// accept list. Commands are loosely typed (`{ op, command_id, ... }`), so read
/// the common payload fields defensively.
function summarizeCommand(command: GraphCommand): string {
  const node = (command as { node?: { node_id?: string; title?: string } }).node;
  const edge = (command as { edge?: { source_node_id?: string; target_node_id?: string } }).edge;
  const nodeId = (command as { node_id?: string }).node_id;
  const edgeId = (command as { edge_id?: string }).edge_id;
  switch (command.op) {
    case "add_node":
      return `+ ${node?.title ?? node?.node_id ?? command.command_id}`;
    case "remove_node":
      return `- ${nodeId ?? command.command_id}`;
    case "update_node":
      return `~ ${nodeId ?? command.command_id}`;
    case "add_edge":
      return `+ ${edge?.source_node_id ?? "?"} → ${edge?.target_node_id ?? "?"}`;
    case "remove_edge":
      return `- ${edgeId ?? command.command_id}`;
    case "update_policy":
      return `⚙ ${nodeId ?? command.command_id}`;
    default:
      return `${command.op}: ${command.command_id}`;
  }
}
