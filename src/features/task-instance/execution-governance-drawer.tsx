/**
 * ExecutionGovernanceDrawer —— 执行治理面（S2 重建）。
 *
 * 设计依据：`01-详细设计.md` §11（GUI 须展示审批请求并回传决策）、§12（干预形态）。
 *           `10-实施现状订正与后续路线图.md` §3.5.1 S2：`e245ab54` 删 task-workbench 的
 *           run-inspector/inspector-panel 时连带删了审批队列/产物/Revision/失败节点干预；
 *           而 hook 侧 resolveApproval/chooseRecovery 一直是零消费者 → 执行中 awaiting_approval
 *           无处审批、节点 failed 无重试入口。本组件重建该治理面，统一为右浮层 4 tab。
 *
 * 消费：use-task-graph 的 approvals / artifacts / revisions / nodeRuns +
 *       resolveApproval / chooseRecovery（此前零消费者）。
 * 干预门控：节点 tab 的 recovery 按钮由 `getInterventionModeForStatus`（S9 契约）驱动——
 *           仅 recovery/retry_wait 形态显示 retry_now/skip_node/fail_node。
 */
import { useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  X,
  RotateCcw,
  SkipForward,
  Ban,
  Box,
  GitCommitVertical,
  ListChecks,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getInterventionModeForStatus } from "./graph/contracts";
import type {
  ApprovalRequest,
  ArtifactRef,
  GraphRevision,
  GraphSnapshot,
  NodeRun,
  RevisionDiff,
} from "./graph/use-task-graph";

export type GovernanceTab = "approvals" | "intervention" | "artifacts" | "revisions";

/** recovery 策略类型，对齐 use-task-graph.chooseRecovery。 */
export type RecoveryStrategy = "retry_now" | "skip_node" | "fail_node";

export interface ExecutionGovernanceDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 初始/受控 tab。父级可据 awaiting_human 自动切到 approvals。 */
  tab: GovernanceTab;
  onTabChange: (tab: GovernanceTab) => void;
  approvals: ApprovalRequest[];
  artifacts: ArtifactRef[];
  revisions: GraphRevision[];
  currentRevisionId: string | null;
  nodeRuns: Record<string, NodeRun>;
  snapshot: GraphSnapshot | null;
  selectedNodeId: string | null;
  /** 完成态只读：隐藏 approve/recover 决策按钮（设计 §11）。 */
  readOnly: boolean;
  /** B4 修订对比：取相邻两版差异（orchestrator_get_diff）。 */
  getDiff?: (fromRevisionId: string, toRevisionId: string) => Promise<RevisionDiff | null>;
  onResolveApproval: (approvalId: string, approved: boolean) => Promise<void>;
  onChooseRecovery: (
    nodeRunId: string,
    strategy: RecoveryStrategy,
    reason: string,
  ) => Promise<void>;
}

export function ExecutionGovernanceDrawer({
  open,
  onClose,
  tab,
  onTabChange,
  approvals,
  artifacts,
  revisions,
  currentRevisionId,
  nodeRuns,
  snapshot,
  selectedNodeId,
  readOnly,
  onResolveApproval,
  onChooseRecovery,
  getDiff,
}: ExecutionGovernanceDrawerProps) {
  const { t } = useTranslation();
  // 进行中的异步动作（审批 id 或 recovery 策略），用于禁用按钮防重复点击。
  const [busy, setBusy] = useState<string | null>(null);

  if (!open) return null;

  // node_run_id → 节点标题（审批卡需要标明属于哪个节点）。
  const nodeRunIdToTitle = new Map<string, string>();
  for (const node of snapshot?.nodes ?? []) {
    const nr = nodeRuns[node.node_id];
    if (nr) nodeRunIdToTitle.set(nr.node_run_id, node.title);
  }

  const handleApprove = async (approvalId: string, approved: boolean) => {
    setBusy(approvalId);
    try {
      await onResolveApproval(approvalId, approved);
    } finally {
      setBusy(null);
    }
  };

  const handleRecover = async (
    nodeRunId: string,
    strategy: RecoveryStrategy,
    nodeTitle: string,
  ) => {
    setBusy(strategy);
    try {
      await onChooseRecovery(
        nodeRunId,
        strategy,
        `${t("task.governance.intervention.manualReason", "人工干预")} ${nodeTitle}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const pendingCount = approvals.filter((a) => !a.resolved).length;

  const tabs: Array<{
    id: GovernanceTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
  }> = [
    {
      id: "approvals",
      label: t("task.governance.tabs.approvals", "审批"),
      icon: Check,
      badge: pendingCount,
    },
    {
      id: "intervention",
      label: t("task.governance.tabs.intervention", "节点干预"),
      icon: AlertTriangle,
    },
    {
      id: "artifacts",
      label: t("task.governance.tabs.artifacts", "产物"),
      icon: Box,
    },
    {
      id: "revisions",
      label: t("task.governance.tabs.revisions", "版本"),
      icon: GitCommitVertical,
    },
  ];

  return (
    <aside className="absolute right-0 top-0 bottom-0 z-40 flex w-[380px] max-w-[80%] flex-col border-l border-border bg-background shadow-xl">
      {/* 标题栏 */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("task.governance.title", "执行治理")}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("task.governance.close", "关闭")}
          title={t("task.governance.close", "关闭")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* tab 行 */}
      <div className="grid shrink-0 grid-cols-4 border-b border-border">
        {tabs.map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onTabChange(item.id)}
              className={cn(
                "relative flex min-h-11 flex-col items-center justify-center gap-1 px-1 py-2 text-[10px] transition",
                active
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="flex items-center gap-1">
                {item.label}
                {item.badge ? (
                  <span className="rounded-full bg-amber-500 px-1.5 text-[9px] font-semibold leading-4 text-white">
                    {item.badge}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "approvals" && (
          <ApprovalsTab
            approvals={approvals}
            nodeRunIdToTitle={nodeRunIdToTitle}
            readOnly={readOnly}
            busy={busy}
            onResolve={handleApprove}
          />
        )}
        {tab === "intervention" && (
          <InterventionTab
            nodeRun={selectedNodeId ? nodeRuns[selectedNodeId] ?? null : null}
            nodeTitle={
              selectedNodeId
                ? snapshot?.nodes.find((n) => n.node_id === selectedNodeId)?.title ?? selectedNodeId
                : null
            }
            readOnly={readOnly}
            busy={busy}
            onRecover={handleRecover}
          />
        )}
        {tab === "artifacts" && (
          <ArtifactsTab
            artifacts={artifacts}
            nodeRuns={nodeRuns}
            selectedNodeId={selectedNodeId}
          />
        )}
        {tab === "revisions" && (
          <RevisionsTab
            revisions={revisions}
            currentRevisionId={currentRevisionId}
            getDiff={getDiff}
          />
        )}
      </div>
    </aside>
  );
}

// ── 审批 tab ──
function ApprovalsTab({
  approvals,
  nodeRunIdToTitle,
  readOnly,
  busy,
  onResolve,
}: {
  approvals: ApprovalRequest[];
  nodeRunIdToTitle: Map<string, string>;
  readOnly: boolean;
  busy: string | null;
  onResolve: (approvalId: string, approved: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  if (approvals.length === 0) {
    return <EmptyState label={t("task.governance.empty.approvals", "暂无审批请求")} />;
  }
  return (
    <div className="space-y-3">
      {approvals.map((approval) => {
        const nodeTitle = nodeRunIdToTitle.get(approval.node_run_id) ?? approval.node_run_id;
        return (
          <div
            key={approval.approval_id}
            className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-3"
          >
            <div className="text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
              {t("task.governance.approvalCard", "审批请求")}
            </div>
            <div className="mt-2 text-xs text-foreground">{approval.description}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
              <span>{t("task.governance.node", "节点")}：{nodeTitle}</span>
              <span>·</span>
              <span>{approval.risk_level}</span>
              {approval.scope.length > 0 && (
                <>
                  <span>·</span>
                  <span>{approval.scope.join(", ")}</span>
                </>
              )}
            </div>
            {approval.resolved ? (
              <div className="mt-3 text-[10px] font-medium text-muted-foreground">
                {approval.approved
                  ? t("task.governance.resolvedApproved", "已通过")
                  : t("task.governance.resolvedRejected", "已驳回")}
              </div>
            ) : readOnly ? (
              <div className="mt-3 text-[10px] text-muted-foreground">
                {t("task.governance.readOnlyHint", "完成态只读，不可审批")}
              </div>
            ) : (
              <div className="mt-3 flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 bg-emerald-600 text-white hover:bg-emerald-700"
                  disabled={busy !== null}
                  onClick={() => onResolve(approval.approval_id, true)}
                >
                  <Check className="mr-1 h-3 w-3" />
                  {t("task.governance.approve", "通过")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={busy !== null}
                  onClick={() => onResolve(approval.approval_id, false)}
                >
                  <X className="mr-1 h-3 w-3" />
                  {t("task.governance.reject", "驳回")}
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── 节点干预 tab ──
function InterventionTab({
  nodeRun,
  nodeTitle,
  readOnly,
  busy,
  onRecover,
}: {
  nodeRun: NodeRun | null;
  nodeTitle: string | null;
  readOnly: boolean;
  busy: string | null;
  onRecover: (
    nodeRunId: string,
    strategy: RecoveryStrategy,
    nodeTitle: string,
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  if (!nodeTitle) {
    return <EmptyState label={t("task.governance.empty.noNodeSelected", "未选中节点")} />;
  }
  if (!nodeRun) {
    return (
      <EmptyState label={t("task.governance.empty.noNodeRun", "该节点尚未产生运行记录")} />
    );
  }

  const mode = getInterventionModeForStatus(nodeRun.status);
  const showRecovery = mode === "recovery" || mode === "retry_wait";

  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">{nodeTitle}</span>
          <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[10px] font-medium">
            {t(`task.nodeStatus.${nodeRun.status}`, nodeRun.status)}
          </span>
        </div>
        <div className="mt-2 text-[10px] text-muted-foreground">
          {t("task.governance.intervention.modeLabel", "干预形态")}：
          {t(`task.governance.intervention.modes.${mode}`, mode)}
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          {t("task.execution.attempt", "尝试")}：{nodeRun.attempt_count}
        </div>
        {nodeRun.error && (
          <div className="mt-2 break-words rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[10px] text-destructive">
            {nodeRun.error}
          </div>
        )}
      </section>

      {showRecovery &&
        (readOnly ? (
          <div className="rounded-lg border border-border p-3 text-[10px] text-muted-foreground">
            {t("task.governance.readOnlyHint", "完成态只读，不可干预")}
          </div>
        ) : (
          <section className="rounded-lg border border-border bg-card p-3">
            <div className="text-[10px] font-medium text-muted-foreground">
              {t("task.governance.intervention.recoveryTitle", "失败节点干预")}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-7 text-[11px]"
                disabled={busy !== null}
                onClick={() => onRecover(nodeRun.node_run_id, "retry_now", nodeTitle)}
              >
                <RotateCcw className="mr-1 h-3 w-3" />
                {t("task.governance.intervention.retryNow", "重试")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                disabled={busy !== null}
                onClick={() => onRecover(nodeRun.node_run_id, "skip_node", nodeTitle)}
              >
                <SkipForward className="mr-1 h-3 w-3" />
                {t("task.governance.intervention.skipNode", "跳过")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                disabled={busy !== null}
                onClick={() => onRecover(nodeRun.node_run_id, "fail_node", nodeTitle)}
              >
                <Ban className="mr-1 h-3 w-3" />
                {t("task.governance.intervention.failNode", "失败")}
              </Button>
            </div>
          </section>
        ))}
    </div>
  );
}

// ── 产物 tab ──
function ArtifactsTab({
  artifacts,
  nodeRuns,
  selectedNodeId,
}: {
  artifacts: ArtifactRef[];
  nodeRuns: Record<string, NodeRun>;
  selectedNodeId: string | null;
}) {
  const { t } = useTranslation();
  // 选中节点时仅显示该节点产物；否则显示全部。
  const nodeRunId = selectedNodeId ? nodeRuns[selectedNodeId]?.node_run_id ?? null : null;
  const list = nodeRunId
    ? artifacts.filter((a) => a.node_run_id === nodeRunId)
    : artifacts;
  if (list.length === 0) {
    return <EmptyState label={t("task.governance.empty.artifacts", "暂无产物")} />;
  }
  return (
    <div className="space-y-2">
      {list.map((artifact) => (
        <div key={artifact.artifact_id} className="rounded-lg border border-border bg-card p-3">
          <div className="text-xs font-medium text-foreground">{artifact.name}</div>
          <div className="mt-1 text-[10px] text-muted-foreground">{artifact.artifact_type}</div>
          <div className="mt-2 break-all font-mono text-[9px] text-muted-foreground">
            {artifact.hash}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 版本 tab ──
function RevisionsTab({
  revisions,
  currentRevisionId,
  getDiff,
}: {
  revisions: GraphRevision[];
  currentRevisionId: string | null;
  getDiff?: (fromRevisionId: string, toRevisionId: string) => Promise<RevisionDiff | null>;
}) {
  const { t } = useTranslation();
  // 展开对比的版本 id；与上一版的差异结果。
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [diff, setDiff] = useState<RevisionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  if (revisions.length === 0) {
    return <EmptyState label={t("task.governance.empty.revisions", "暂无版本")} />;
  }
  // 倒序（最新在前）；reversed[i+1] 即 reversed[i] 的上一版（更旧）。
  const ordered = revisions.slice().reverse();
  const toggleDiff = (index: number, revisionId: string, prevId: string) => {
    if (!getDiff) return;
    // 再次点击同一项则收起。
    if (diffFor === revisionId) {
      setDiffFor(null);
      setDiff(null);
      return;
    }
    setDiffFor(revisionId);
    setDiff(null);
    setDiffLoading(true);
    getDiff(prevId, revisionId)
      .then((result) => setDiff(result))
      .catch(() => setDiff(null))
      .finally(() => setDiffLoading(false));
  };
  return (
    <div className="space-y-2">
      {ordered.map((revision, index) => {
        const isCurrent = revision.revision_id === currentRevisionId;
        // 倒序中更旧的版本在 index+1；最旧版本无上一版。
        const prev = ordered[index + 1];
        const canCompare = !!getDiff && !!prev;
        const expanded = diffFor === revision.revision_id;
        return (
          <div
            key={revision.revision_id}
            className={cn(
              "rounded-lg border p-3",
              isCurrent ? "border-primary bg-primary/5" : "border-border bg-card",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[10px] text-foreground">
                {revision.revision_id}
              </span>
              {isCurrent && (
                <span className="shrink-0 rounded bg-primary px-1.5 py-0.5 text-[9px] font-medium text-primary-foreground">
                  {t("task.governance.currentRevision", "当前")}
                </span>
              )}
            </div>
            <div className="mt-2 break-words text-[10px] text-muted-foreground">
              {revision.change_summary || revision.author}
            </div>
            <div className="mt-1 break-all font-mono text-[9px] text-muted-foreground">
              {revision.content_hash}
            </div>
            {canCompare && (
              <button
                type="button"
                className="mt-2 text-[10px] font-medium text-primary hover:underline disabled:opacity-50"
                onClick={() => toggleDiff(index, revision.revision_id, prev.revision_id)}
                disabled={diffLoading && expanded}
              >
                {expanded
                  ? t("tasks.orchestration.diff.hide")
                  : t("tasks.orchestration.diff.comparePrev")}
              </button>
            )}
            {expanded && (
              <RevisionDiffBody loading={diffLoading} diff={diff} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// B4 修订对比：相邻两版差异的结构化展示（新增/更新/删除节点 + 边变化）。
function RevisionDiffBody({ loading, diff }: { loading: boolean; diff: RevisionDiff | null }) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="mt-2 text-[10px] text-muted-foreground">
        {t("tasks.orchestration.diff.loading")}
      </div>
    );
  }
  if (!diff) {
    return (
      <div className="mt-2 text-[10px] text-muted-foreground">
        {t("tasks.orchestration.diff.unavailable")}
      </div>
    );
  }
  const isEmpty =
    diff.nodes_added.length === 0 &&
    diff.nodes_removed.length === 0 &&
    diff.nodes_updated.length === 0 &&
    diff.edges_added.length === 0 &&
    diff.edges_removed.length === 0;
  if (isEmpty) {
    return (
      <div className="mt-2 text-[10px] text-muted-foreground">
        {t("tasks.orchestration.diff.unchanged")}
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-1 text-[10px]">
      {diff.nodes_added.length > 0 && (
        <div className="text-emerald-600 dark:text-emerald-400">
          + {t("tasks.orchestration.diff.nodesAdded", { count: diff.nodes_added.length })}
        </div>
      )}
      {diff.nodes_updated.length > 0 && (
        <div className="text-blue-600 dark:text-blue-400">
          ~ {t("tasks.orchestration.diff.nodesUpdated", { count: diff.nodes_updated.length })}
        </div>
      )}
      {diff.nodes_removed.length > 0 && (
        <div className="text-red-600 dark:text-red-400">
          − {t("tasks.orchestration.diff.nodesRemoved", { count: diff.nodes_removed.length })}
        </div>
      )}
      {diff.edges_added.length > 0 && (
        <div className="text-muted-foreground">
          + {t("tasks.orchestration.diff.edgesAdded", { count: diff.edges_added.length })}
        </div>
      )}
      {diff.edges_removed.length > 0 && (
        <div className="text-muted-foreground">
          − {t("tasks.orchestration.diff.edgesRemoved", { count: diff.edges_removed.length })}
        </div>
      )}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}
