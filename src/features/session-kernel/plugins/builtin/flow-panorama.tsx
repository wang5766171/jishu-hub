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
        {task.nodes.map((node, index) => {
          const style = STATUS_STYLE[node.status] ?? STATUS_STYLE.ready;
          const Icon = style.icon;
          const clickable = node.status !== "blocked" && node.status !== "ready";
          return (
            <button
              key={node.nodeId}
              type="button"
              disabled={!clickable}
              onClick={() => task.onSelectNode(node.nodeId)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                clickable ? "hover:bg-accent" : "cursor-default opacity-70",
              )}
            >
              <span className="w-4 shrink-0 text-center text-[10px] text-muted-foreground/60">
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
