/**
 * 内置渲染原语（需求13 C2）：divider / hover-card / list / turn-rail /
 * mono-text / none——组合式插件的非第三方渲染件（零外部依赖的纯原语）。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Ban,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Clock,
  Loader2,
  Map,
  MessageSquareText,
  MessagesSquare,
  MinusCircle,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PhaseDivider } from "@/components/sessions/conversation-content";
import { TurnRail } from "@/components/sessions/turn-rail";
import { cfgBool, cfgNum } from "../../../plugins/config-plane";
import { rendererRegistry } from "../registry";
import type { RendererComponentProps, SourcePayload } from "../../types";
import type { ToolStats as ToolStatsShape } from "../../sources/aggregate-source";

// ── render.divider：阶段分隔条（block-type 源配 block-renderer 挂载） ──
function DividerPrimitive({ payload }: RendererComponentProps<SourcePayload>) {
  const block = payload.kind === "block" ? (payload.block as { phase?: string; title?: string; text?: string }) : null;
  return <PhaseDivider phase={block?.phase ?? block?.text ?? ""} title={block?.title ?? ""} />;
}
rendererRegistry.register({ key: "render.divider", component: DividerPrimitive, description: "阶段分隔条（阶段块的视觉分界）" });

// ── render.task-board：任务看板（task 源配 dock 挂载；C5-slice1 自
//    builtin/flow-panorama 下沉——节点清单实时状态/钻入子会话/主会话常驻
//    入口/画布/取消全部，数据与命令全部经 TaskPanelContext）。 ──
const TASK_STATUS_STYLE: Record<string, { icon: typeof MessageSquareText; cls: string }> = {
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

function TaskBoardPrimitive({ payload }: RendererComponentProps<SourcePayload>) {
  const { t } = useTranslation();
  const task = payload.kind === "task" ? payload.task : null;
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
        {/* 主会话入口（常驻，置顶于节点列表）：看板是子会话唯一入口，回/进
            主会话也必须在此常驻可及。onSelectNode(null) = 取消节点选择，
            主区回退任务的阶段会话。 */}
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
          const style = TASK_STATUS_STYLE[node.status] ?? TASK_STATUS_STYLE.ready;
          const Icon = style.icon;
          const clickable = node.status !== "blocked" && node.status !== "ready";
          // 当前钻入节点用主色背景 + 左缘竖条高亮（看板是子会话唯一入口，
          // 选中态必须一眼可辨）。
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
rendererRegistry.register({ key: "render.task-board", component: TaskBoardPrimitive, description: "任务看板（节点状态/钻入子会话/主会话入口/取消流程）" });

// ── render.hover-card：挂件细条 + 悬停统计卡（aggregate 源配 rail 挂载） ──
function HoverCardPrimitive({ payload, options }: RendererComponentProps<SourcePayload>) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const stats = payload.kind === "aggregate" ? (payload.data as ToolStatsShape | undefined) : undefined;
  if (!stats || stats.total === 0) return null;
  const topN = cfgNum(options, "topN", 6);
  const showRatio = cfgBool(options, "showErrorRatio", true);
  const errorRatio = Math.round((stats.errors / stats.total) * 100);
  const title = t("sessionPlugins.toolStats.hoverTitle", "本会话工具调用统计");
  return (
    <div className="pointer-events-auto relative" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div
        title={title}
        className={cn(
          "flex h-4 items-center gap-1 rounded-full px-1.5 text-[9px] font-medium transition-colors",
          stats.errors > 0 ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-muted text-muted-foreground",
        )}
      >
        <Wrench className="h-2.5 w-2.5" />
        <span className="tabular-nums">{stats.total}{stats.errors > 0 ? `/${stats.errors}` : ""}</span>
      </div>
      {hovered ? (
        <div className="absolute left-0 top-5 z-30 w-48 rounded-lg border border-border/70 bg-popover/95 p-2 shadow-lg backdrop-blur">
          <div className="mb-1 text-[10px] font-medium text-foreground">{title}</div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{t("sessionPlugins.toolStats.total", "调用总数")}</span>
            <span className="tabular-nums">{stats.total}</span>
          </div>
          {showRatio ? (
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{t("sessionPlugins.toolStats.errors", "失败（回放口径）")}</span>
              <span className="tabular-nums text-amber-600 dark:text-amber-400">{stats.errors}（{errorRatio}%）</span>
            </div>
          ) : null}
          <div className="mt-1 border-t border-border/50 pt-1">
            {stats.byName.slice(0, topN).map((item) => (
              <div key={item.name} className="flex justify-between text-[10px] text-muted-foreground">
                <span className="truncate">{item.name}</span>
                <span className="ml-2 shrink-0 tabular-nums">{item.count}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
rendererRegistry.register({ key: "render.hover-card", component: HoverCardPrimitive, description: "挂件细条+悬停统计卡（工具统计类）" });

// ── render.list：大纲列表（turns 源配 dock 挂载；点击跳转经 payload.jump） ──
function ListPrimitive({ payload }: RendererComponentProps<SourcePayload>) {
  const { t } = useTranslation();
  if (payload.kind !== "turns") return null;
  const jump = (payload as { jump?: (i: number) => void }).jump;
  if (payload.turns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        {t("sessionPlugins.outline.empty", "暂无对话轮次")}
      </div>
    );
  }
  const outlineLine = (text: string, max = 46) => {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max)}…` : line;
  };
  return (
    <div className="h-full overflow-auto p-2">
      {payload.turns.map((turn, index) => {
        const active = index === payload.activeIndex;
        return (
          <button
            key={index}
            type="button"
            onClick={() => jump?.(index)}
            className={cn(
              "mb-1 flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors",
              active ? "bg-accent/60" : "hover:bg-accent/40",
            )}
          >
            <MessageSquareText className={cn("mt-0.5 h-3 w-3 shrink-0", active ? "text-primary" : "text-muted-foreground/60")} />
            <span className="min-w-0 flex-1">
              <span className={cn("block text-[11px] leading-snug", active ? "text-foreground font-medium" : "text-foreground/80")}>
                {outlineLine(turn.question) || t("sessionPlugins.outline.untitled", "（未命名轮次）")}
              </span>
              {turn.answer ? <span className="block truncate text-[10px] leading-snug text-muted-foreground/70">{outlineLine(turn.answer, 38)}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
rendererRegistry.register({ key: "render.list", component: ListPrimitive, description: "轮次大纲列表（点击跳转）" });

// ── render.stats-list：统计面板（aggregate 源配 dock 挂载；能力中心收纳，
// 不再常驻会话边缘——rail 挂件遮挡内容的测试期反馈，用户裁决迁停靠面板） ──
function StatsListPrimitive({ payload, options }: RendererComponentProps<SourcePayload>) {
  const { t } = useTranslation();
  const stats = payload.kind === "aggregate" ? (payload.data as ToolStatsShape | undefined) : undefined;
  if (!stats || stats.total === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        {t("sessionPlugins.toolStats.empty", "本会话暂无工具调用")}
      </div>
    );
  }
  const topN = cfgNum(options, "topN", 6);
  const showRatio = cfgBool(options, "showErrorRatio", true);
  const errorRatio = Math.round((stats.errors / stats.total) * 100);
  return (
    <div className="h-full overflow-auto p-3">
      <div className="mb-2 grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-muted/40 px-3 py-2">
          <div className="text-[10px] text-muted-foreground">{t("sessionPlugins.toolStats.total", "调用总数")}</div>
          <div className="text-lg font-semibold tabular-nums">{stats.total}</div>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-2">
          <div className="text-[10px] text-muted-foreground">{t("sessionPlugins.toolStats.errors", "失败（回放口径）")}</div>
          <div className={cn("text-lg font-semibold tabular-nums", stats.errors > 0 && "text-amber-600 dark:text-amber-400")}>
            {stats.errors}{showRatio ? `（${errorRatio}%）` : ""}
          </div>
        </div>
      </div>
      <div className="space-y-0.5">
        {stats.byName.slice(0, topN).map((item) => (
          <div key={item.name} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/85">{item.name}</span>
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.round((item.count / stats.byName[0].count) * 100)}%` }} />
            </div>
            <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{item.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
rendererRegistry.register({ key: "render.stats-list", component: StatsListPrimitive, description: "工具统计面板（总数/失败/分布条形）" });

// ── render.turn-rail：导航条（turns 源配 rail 挂载）——真件复用 TurnRail
// （条形可视化+悬停预览+点击跳转；其自带 pointer-events-auto，宿主穿透
// 设计下点击可达——C2 首版降级为无 pointer-events 的圆点致点击失效，
// 测试期用户实测打回，还原）。 ──
function TurnRailPrimitive({ payload }: RendererComponentProps<SourcePayload>) {
  if (payload.kind !== "turns") return null;
  const jump = (payload as { jump?: (i: number) => void }).jump;
  return <TurnRail turns={payload.turns} activeIndex={payload.activeIndex} onJump={(i) => jump?.(i)} />;
}
rendererRegistry.register({ key: "render.turn-rail", component: TurnRailPrimitive, description: "轮次导航圆点条（点击跳转）" });

// ── render.mono-text：等宽文本兜底 ──
function MonoTextPrimitive({ payload }: RendererComponentProps<SourcePayload>) {
  const code = payload.kind === "code-block" ? payload.code : JSON.stringify(payload, null, 2);
  return (
    <pre className="my-2 overflow-auto rounded-lg border border-border/60 p-2 text-xs leading-relaxed">
      <code>{code}</code>
    </pre>
  );
}
rendererRegistry.register({ key: "render.mono-text", component: MonoTextPrimitive, description: "等宽文本（兜底渲染）" });

// ── render.none：无渲染（event-hook 类插件占位） ──
function NonePrimitive(): null {
  return null;
}
rendererRegistry.register({ key: "render.none", component: NonePrimitive, description: "无渲染（纯动作/事件类插件占位）" });
