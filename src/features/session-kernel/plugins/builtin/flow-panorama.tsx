import { useTranslation } from "react-i18next";
import {
  Ban,
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDot,
  Clock,
  Loader2,
  Map,
  MessagesSquare,
  MinusCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionKernelContext, SessionPluginDescriptor } from "../types";

/**
 * 任务流程全景插件（v0.9.2 需求2 / M3 首个真实停靠面板）。
 *
 * 交互形态（02 设计 §3.2 阶段C'）：默认停靠右侧，节点清单实时状态、
 * 点击行钻入子任务会话；底部入口：全屏画布（高级视图）与取消整个流程。
 * 与核心会话松耦合：数据/命令全部经 SessionKernelContext.task。
 */

const STATUS_STYLE: Record<string, { icon: typeof Circle; cls: string }> = {
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
  ready: { icon: CircleDot, cls: "text-muted-foreground/80" },
  blocked: { icon: Clock, cls: "text-muted-foreground/50" },
};

function FlowPanoramaPanel({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const task = ctx.task;
  if (!task) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        {t("sessionPlugins.flow.noTask", "当前会话未关联任务")}
      </div>
    );
  }
  const runActive = task.runStatus === "running";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
        <span className="truncate font-medium text-foreground">{task.title}</span>
        <span className="shrink-0 tabular-nums">
          {t("sessionPlugins.flow.progress", {
            completed: task.completed,
            total: task.total,
            defaultValue: "{{completed}}/{{total}}",
          })}
        </span>
        <button
          type="button"
          onClick={task.onOpenCanvas}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("sessionPlugins.flow.openCanvas", "画布")}
        >
          <Map className="h-3 w-3" />
          {t("sessionPlugins.flow.openCanvas", "画布")}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
        {/* 主会话入口（常驻，置顶于节点列表）：与节点行同构——看板是子会话
            唯一入口，回/进主会话也必须在此常驻可及（仅选中节点时才出现的话，
            未选中状态下面板无任何主会话线索）。onSelectNode(null) = 取消节点
            选择，主区回退任务的阶段会话（规划优先/回退需求）。 */}
        <button
          type="button"
          onClick={() => task.onSelectNode(null)}
          className={cn(
            "mb-1 flex w-full items-center gap-2 rounded-md border-l-2 px-2 py-1.5 text-left text-xs transition-colors",
            task.selectedNodeId
              ? "border-l-transparent text-foreground/90 hover:bg-accent"
              : "border-l-primary bg-primary/20 font-medium text-foreground",
          )}
          title={t("sessionPlugins.flow.mainSessionHint", "本任务的需求/规划/执行讨论会话")}
        >
          <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">{t("sessionPlugins.flow.mainSession", "主会话")}</span>
          {!task.selectedNodeId ? (
            <span className="shrink-0 text-[10px] text-muted-foreground/60">
              {t("sessionPlugins.flow.currentPosition", "当前")}
            </span>
          ) : null}
        </button>
        {task.nodes.map((node, index) => {
          const style = STATUS_STYLE[node.status] ?? STATUS_STYLE.ready;
          const Icon = style.icon;
          const clickable = node.status !== "blocked" && node.status !== "ready";
          // 2026-09-11 用户反馈：点击子会话后无选中反馈——当前钻入节点用
          // 主色背景 + 左缘竖条高亮，效果明显（左侧任务列表不再展示子会话，
          // 看板是唯一的子会话入口，选中态必须一眼可辨）。
          const isSelected = task.selectedNodeId === node.nodeId;
          return (
            <button
              key={node.nodeId}
              type="button"
              disabled={!clickable}
              onClick={() => task.onSelectNode(node.nodeId)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md border-l-2 px-2 py-1.5 text-left text-xs transition-colors",
                isSelected
                  ? "border-l-primary bg-primary/20 font-medium text-foreground"
                  : cn(
                      "border-l-transparent",
                      clickable ? "hover:bg-accent" : "cursor-default opacity-70",
                    ),
              )}
            >
              <span className={cn(
                "w-4 shrink-0 text-center text-[10px]",
                isSelected ? "text-primary" : "text-muted-foreground/60",
              )}>
                {index + 1}
              </span>
              <Icon className={cn("h-3.5 w-3.5 shrink-0", style.cls)} />
              <span className="min-w-0 flex-1 truncate text-foreground/90">{node.title}</span>
              {node.waitingFor && (
                <span className="shrink-0 text-[10px] text-muted-foreground/60">
                  {node.waitingFor}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {runActive && (
        <div className="flex items-center gap-1.5 border-t border-border/40 px-2 py-1.5">
          <button
            type="button"
            onClick={task.onCancelRun}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-red-500/40 px-2 py-1 text-[11px] text-red-500 hover:bg-red-500/10"
          >
            <Ban className="h-3 w-3" />
            {t("sessionPlugins.flow.cancelAll", "取消全部")}
          </button>
        </div>
      )}
    </div>
  );
}

export const flowPanoramaPlugin: SessionPluginDescriptor = {
  id: "session.flow",
  displayNameKey: "sessionPlugins.flow.name",
  displayNameFallback: "任务流程全景",
  descriptionKey: "sessionPlugins.flow.description",
  descriptionFallback: "任务方案确认、子任务执行跟踪与干预",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:turns", "task:read", "task:select-node", "task:cancel-run", "task:open-canvas"],
  mounts: [
    {
      kind: "dock-panel",
      titleKey: "sessionPlugins.flow.panelTitle",
      titleFallback: "任务全景",
      Component: FlowPanoramaPanel,
      defaultSlot: "right",
    },
  ],
};
