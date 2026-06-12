import { useTranslation } from "react-i18next";
import type { GraphProposal } from "./use-task-graph";

interface ProposalReviewProps {
  proposal: GraphProposal;
  accepting: boolean;
  onAccept: () => Promise<void>;
  onDismiss: () => void;
}

export function ProposalReview({
  proposal,
  accepting,
  onAccept,
  onDismiss,
}: ProposalReviewProps) {
  const { t } = useTranslation();
  const diff = proposal.diff;

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-slate-950/75 p-6 backdrop-blur-sm">
      <section className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-cyan-400/25 bg-slate-950 p-6 shadow-2xl shadow-cyan-950/50">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-300">
              {t("tasks.workbench.proposalEyebrow")}
            </div>
            <h2 className="mt-2 text-2xl font-semibold text-slate-50">
              {t("tasks.workbench.proposalTitle")}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-300">{proposal.rationale}</p>
          </div>
          <button
            type="button"
            className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-900"
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
          <h3 className="text-sm font-semibold text-slate-100">
            {t("tasks.workbench.proposedNodes")}
          </h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {diff.nodes_added.map((nodeId) => (
              <span
                key={nodeId}
                className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-100"
              >
                {nodeId}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-7 flex justify-end gap-3 border-t border-slate-800 pt-5">
          <button
            type="button"
            className="rounded border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-900"
            onClick={onDismiss}
          >
            {t("tasks.workbench.rejectProposal")}
          </button>
          <button
            type="button"
            disabled={accepting}
            className="rounded bg-cyan-400 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => onAccept().catch(console.error)}
          >
            {accepting
              ? t("tasks.workbench.acceptingProposal")
              : t("tasks.workbench.acceptProposal")}
          </button>
        </div>
      </section>
    </div>
  );
}

function DiffMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
      <div className="text-2xl font-semibold text-slate-50">{value}</div>
      <div className="mt-1 text-xs text-slate-400">{label}</div>
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
      ? "border-emerald-400/20 bg-emerald-400/5 text-emerald-100"
      : tone === "risk"
        ? "border-rose-400/20 bg-rose-400/5 text-rose-100"
        : "border-amber-400/20 bg-amber-400/5 text-amber-100";
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
