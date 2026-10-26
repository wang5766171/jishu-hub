/**
 * 任务流程卡片组（v0.9.2 需求2 M3-2/3/4）——会话流内的流程执行呈现：
 *
 * - TaskPlanCard 方案卡：规划完成后「确认执行」前的子任务清单（勾选决定
 *   执行哪些 / 查看职责与验收 / 画布高级编辑 / 先调整去对话）。
 * - TaskNodeCards 子任务卡：执行中的节点实时状态卡（状态 + 当前动作一行
 *   摘要 + 进入会话），替代原 run 事件第一人称投影消息。
 * - TaskSummaryCard 汇总卡：run 终态后的各节点结果汇总。
 *
 * v1 实现形态：组件置于 task-workspace 功能域、由 chat-page 执行段合流渲染；
 * 挂载点化（session.flow 插件 flow-card mount）随后续版本收编（02 §1 备注）。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Check,
  Loader2,
  Map,
  MessageSquare,
  MinusCircle,
  Play,
  RotateCw,
  SkipForward,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface PlanNodeInfo {
  nodeId: string;
  title: string;
  responsibility: string;
  acceptance: string | null;
  /** v0.9.3 需求5：行内更换执行者——画布指定的锁定 agent（null = 角色解析）。 */
  agentId: string | null;
  /** 执行者约束的角色前提（update_node patch 需要；缺省用 node_id 兜底，同画布）。 */
  roleId: string;
}

export interface FlowNodeStatus {
  nodeId: string;
  title: string;
  status: string;
  agentName: string | null;
  lastAction: string | null;
  clickable: boolean;
  /** v0.9.3 需求5 摘要增强：耗时（ms 时间戳）与验收标准。 */
  startedAt?: number | null;
  finishedAt?: number | null;
  acceptance?: string | null;
  /** 失败原因（node run error；重试/跳过提示与失败行展示）。 */
  error?: string | null;
}

/** 耗时格式化（s/m/h；执行中显示为至今的经过时长）。 */
export function formatNodeDuration(
  startedAt?: number | null,
  finishedAt?: number | null,
): string | null {
  if (!startedAt) return null;
  const end = finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m${rest ? ` ${rest}s` : ""}`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const STATUS_ICON: Record<string, { icon: typeof Clock; cls: string }> = {
  succeeded: { icon: CheckCircle2, cls: "text-emerald-500" },
  failed: { icon: CircleAlert, cls: "text-red-500" },
  cancelled: { icon: MinusCircle, cls: "text-muted-foreground" },
  skipped: { icon: MinusCircle, cls: "text-muted-foreground/60" },
  superseded: { icon: MinusCircle, cls: "text-muted-foreground/60" },
  running: { icon: Loader2, cls: "text-blue-500 animate-spin" },
  leased: { icon: Loader2, cls: "text-blue-500/70 animate-spin" },
  repairing: { icon: Loader2, cls: "text-blue-500 animate-spin" },
  retry_wait: { icon: Clock, cls: "text-amber-500" },
  awaiting_approval: { icon: Clock, cls: "text-amber-500" },
  ready: { icon: Clock, cls: "text-muted-foreground/60" },
  blocked: { icon: Clock, cls: "text-muted-foreground/40" },
};

export function statusVisual(status: string) {
  return STATUS_ICON[status] ?? STATUS_ICON.ready;
}

/** 方案卡：确认执行哪些子任务。v0.9.3 需求5：节点行内可直接更换执行者
 *（与画布 Inspector 同源 update_node，run 启动前可用）。 */
export function TaskPlanCard({
  nodes,
  canStart,
  starting,
  error,
  onConfirm,
  onDismiss,
  onOpenCanvas,
  assignableAgents,
  agentsLoading,
  onAssignAgent,
}: {
  nodes: PlanNodeInfo[];
  canStart: boolean;
  starting: boolean;
  error: string | null;
  onConfirm: (selectedIds: string[]) => void;
  onDismiss: () => void;
  onOpenCanvas: () => void;
  assignableAgents?: Array<{ id: string; display_name: string }>;
  agentsLoading?: boolean;
  onAssignAgent?: (nodeId: string, agentId: string | null) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(nodes.map((node) => node.nodeId)),
  );
  if (nodes.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4 py-2 text-[12px] text-muted-foreground">
        {t("task.execution.confirmDescEmpty", "流程尚未生成步骤，请先在下方对话中让任务助手补全流程。")}
      </div>
    );
  }
  const allSelected = selected.size === nodes.length;
  return (
    <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4 py-2">
      <div className="rounded-xl border border-border bg-muted/60 p-4 colorful:border-emerald-200/70 colorful:bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/30">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground colorful:bg-emerald-500/15 colorful:text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              {t("taskPlan.cardTitle", "任务方案")}
              <span className="text-[11px] font-normal text-muted-foreground">
                {t("taskPlan.nodeCount", { count: nodes.length, defaultValue: "共 {{count}} 个子任务" })}
              </span>
              <button
                type="button"
                onClick={onOpenCanvas}
                className="ml-auto flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Map className="h-3 w-3" />
                {t("taskPlan.openCanvas", "画布高级编辑")}
              </button>
            </div>
            <div className="mt-2 space-y-1">
              <button
                type="button"
                onClick={() =>
                  setSelected(allSelected ? new Set() : new Set(nodes.map((n) => n.nodeId)))
                }
                className="flex h-6 items-center gap-1 rounded-md border border-border/60 px-2 text-[11px] text-foreground/80 transition-fast hover:bg-accent hover:text-foreground"
              >
                <span
                  className={cn(
                    "flex h-3 w-3 items-center justify-center rounded-[3px] border",
                    allSelected
                      ? "border-emerald-600 bg-emerald-600 text-white"
                      : "border-border bg-background",
                  )}
                >
                  {allSelected ? <Check className="h-2.5 w-2.5" /> : null}
                </span>
                {allSelected ? t("taskPlan.unselectAll", "全不选") : t("taskPlan.selectAll", "全选")}
              </button>
              {nodes.map((node, index) => {
                const checked = selected.has(node.nodeId);
                return (
                  <label
                    key={node.nodeId}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 transition-colors",
                      checked
                        ? "border-border/60 bg-background/70"
                        : "border-border/30 bg-background/30 opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (next.has(node.nodeId)) next.delete(node.nodeId);
                          else next.add(node.nodeId);
                          return next;
                        })
                      }
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-600"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                        <span className="text-muted-foreground/60">{index + 1}.</span>
                        <span className="truncate">{node.title}</span>
                        {onAssignAgent && assignableAgents && assignableAgents.length > 0 && (
                          <label
                            className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <span>{t("taskPlan.executor", "执行者")}</span>
                            <select
                              value={node.agentId ?? ""}
                              disabled={starting}
                              onChange={(event) => {
                                const value = event.target.value;
                                onAssignAgent(node.nodeId, value || null);
                              }}
                              className="h-5 max-w-32 rounded border border-border bg-background px-1 text-[10px] text-foreground"
                            >
                              <option value="">
                                {agentsLoading
                                  ? t("task.execution.agentsLoading", "加载智能体…")
                                  : t("taskPlan.autoAssign", "自动分配")}
                              </option>
                              {assignableAgents.map((agent) => (
                                <option key={agent.id} value={agent.id}>
                                  {agent.display_name}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                      </div>
                      {node.responsibility && (
                        <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                          {node.responsibility}
                        </div>
                      )}
                      {node.acceptance && (
                        <div className="mt-0.5 line-clamp-1 text-[10px] leading-snug text-muted-foreground/70">
                          {t("taskPlan.acceptance", "验收")}：{node.acceptance}
                        </div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
            {error ? (
              <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-600 dark:text-red-300">
                {error}
              </div>
            ) : null}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => onConfirm(Array.from(selected))}
                disabled={!canStart || starting || selected.size === 0}
                className="flex h-7 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-[12px] font-medium text-white transition-fast hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-3 w-3" />
                {starting
                  ? t("task.execution.starting", "启动中…")
                  : t("taskPlan.confirmRun", { count: selected.size, defaultValue: "确认执行（{{count}} 项）" })}
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="flex h-7 items-center rounded-md px-3 text-[12px] text-muted-foreground transition-fast hover:bg-accent hover:text-foreground"
              >
                {t("task.execution.adjustFirst", "先调整流程")}
              </button>
              <span className="ml-auto hidden text-[10px] text-muted-foreground/60 sm:block">
                {t("taskPlan.uncheckedHint", "未勾选的子任务将从本次执行中移除")}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 子任务卡列表：执行中实时状态。v0.9.3 需求5 摘要增强：耗时 / 验收标准
 * 展开 / 失败原因。 */
export function TaskNodeCards({
  nodes,
  onSelectNode,
}: {
  nodes: FlowNodeStatus[];
  onSelectNode: (nodeId: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  if (nodes.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-[var(--message-content-max-width)] space-y-2 px-4 py-2">
      {nodes.map((node, index) => {
        const visual = statusVisual(node.status);
        const Icon = visual.icon;
        const duration = formatNodeDuration(node.startedAt, node.finishedAt);
        const acceptanceOpen = expanded.has(node.nodeId);
        return (
          <div
            key={node.nodeId}
            data-flow-node={node.nodeId}
            className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground/50">{index + 1}</span>
              <Icon className={cn("h-4 w-4 shrink-0", visual.cls)} />
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                onClick={() =>
                  node.acceptance &&
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(node.nodeId)) next.delete(node.nodeId);
                    else next.add(node.nodeId);
                    return next;
                  })
                }
                title={node.acceptance ? t("taskFlow.toggleAcceptance", "展开/收起验收标准") : undefined}
              >
                <span className="truncate text-xs font-medium text-foreground">{node.title}</span>
                {node.acceptance &&
                  (acceptanceOpen ? (
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                  ))}
              </button>
              {node.agentName && (
                <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                  {node.agentName}
                </span>
              )}
              {duration && (
                <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/50">
                  {duration}
                </span>
              )}
              <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/60">
                {t(`taskFlow.status.${node.status}`, node.status)}
              </span>
              {node.clickable && (
                <button
                  type="button"
                  onClick={() => onSelectNode(node.nodeId)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <MessageSquare className="h-3 w-3" />
                  {t("taskFlow.openSession", "进入会话")}
                </button>
              )}
            </div>
            {node.lastAction && (
              <div className="mt-1 truncate pl-6 text-[11px] leading-snug text-muted-foreground/80">
                {node.lastAction}
              </div>
            )}
            {node.status === "failed" && node.error && (
              <div className="mt-1 truncate pl-6 text-[11px] leading-snug text-red-500/90" title={node.error}>
                {node.error}
              </div>
            )}
            {acceptanceOpen && node.acceptance && (
              <div className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted/60 px-2 py-1 text-[10px] leading-snug text-muted-foreground">
                <span className="font-medium text-muted-foreground/80">
                  {t("taskPlan.acceptance", "验收")}：
                </span>
                {node.acceptance}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 汇总卡：run 终态后的结果一览。v0.9.3 需求5：失败节点行内「重试」「跳过
 *（下游继续）」；完成行附耗时与一句结果摘要（attempt 公开消息最新一条）。 */
export function TaskSummaryCard({
  runStatus,
  nodes,
  onSelectNode,
  onRetryNode,
  onSkipNode,
  nodeActionBusy,
}: {
  runStatus: string;
  nodes: FlowNodeStatus[];
  onSelectNode: (nodeId: string) => void;
  onRetryNode?: (nodeId: string) => void;
  onSkipNode?: (nodeId: string) => void;
  nodeActionBusy?: string | null;
}) {
  const { t } = useTranslation();
  const succeeded = nodes.filter((n) => n.status === "succeeded").length;
  const failed = nodes.filter((n) => n.status === "failed").length;
  const skipped = nodes.filter((n) => ["skipped", "cancelled", "superseded"].includes(n.status)).length;
  const titleMap: Record<string, string> = {
    completed: t("taskSummary.completed", "任务完成"),
    failed: t("taskSummary.failed", "任务失败"),
    cancelled: t("taskSummary.cancelled", "任务已取消"),
  };
  return (
    <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4 py-2">
      <div
        className={cn(
          "rounded-xl border p-4",
          runStatus === "completed"
            ? "border-emerald-500/40 bg-emerald-500/5"
            : runStatus === "failed"
              ? "border-red-500/40 bg-red-500/5"
              : "border-border bg-muted/40",
        )}
      >
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          {runStatus === "completed" ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          ) : runStatus === "failed" ? (
            <CircleAlert className="h-4 w-4 text-red-500" />
          ) : (
            <Ban className="h-4 w-4 text-muted-foreground" />
          )}
          {titleMap[runStatus] ?? runStatus}
          <span className="ml-auto text-[11px] font-normal tabular-nums text-muted-foreground">
            {t("taskSummary.counts", {
              succeeded,
              failed,
              skipped,
              total: nodes.length,
              defaultValue: "成功 {{succeeded}} / 失败 {{failed}} / 跳过 {{skipped}} · 共 {{total}}",
            })}
          </span>
        </div>
        <div className="mt-2 space-y-1">
          {nodes.map((node) => {
            const visual = statusVisual(node.status);
            const Icon = visual.icon;
            const duration = formatNodeDuration(node.startedAt, node.finishedAt);
            const busy = nodeActionBusy === node.nodeId;
            const actionable = node.status === "failed" && !busy && Boolean(onRetryNode || onSkipNode);
            return (
              <div key={node.nodeId} className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => node.clickable && onSelectNode(node.nodeId)}
                  disabled={!node.clickable}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs",
                    node.clickable ? "hover:bg-accent/50" : "cursor-default",
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5 shrink-0", visual.cls)} />
                  <span className="min-w-0 flex-1 truncate text-foreground/90">{node.title}</span>
                  {node.agentName && (
                    <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                      {node.agentName}
                    </span>
                  )}
                  {duration && (
                    <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/50">
                      {duration}
                    </span>
                  )}
                </button>
                {node.status === "failed" && node.error && (
                  <div className="truncate pl-7 text-[10px] leading-snug text-red-500/80" title={node.error}>
                    {node.error}
                  </div>
                )}
                {node.status !== "failed" && node.lastAction && (
                  <div className="truncate pl-7 text-[10px] leading-snug text-muted-foreground/60" title={node.lastAction}>
                    {node.lastAction}
                  </div>
                )}
                {node.status === "failed" && (onRetryNode || onSkipNode) && (
                  <div className="flex items-center gap-1.5 pl-7">
                    {busy && (
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {t("taskFlow.nodeActionWorking", "处理中…")}
                      </span>
                    )}
                    {onRetryNode && (
                      <button
                        type="button"
                        disabled={!actionable}
                        onClick={(event) => {
                          event.stopPropagation();
                          onRetryNode(node.nodeId);
                        }}
                        className="flex h-5 items-center gap-1 rounded-md border border-border/60 px-1.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RotateCw className="h-3 w-3" />
                        {t("taskFlow.retryNode", "重试")}
                      </button>
                    )}
                    {onSkipNode && (
                      <button
                        type="button"
                        disabled={!actionable}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSkipNode(node.nodeId);
                        }}
                        className="flex h-5 items-center gap-1 rounded-md border border-border/60 px-1.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <SkipForward className="h-3 w-3" />
                        {t("taskFlow.skipNode", "跳过（下游继续）")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
