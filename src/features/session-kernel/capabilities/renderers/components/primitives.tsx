/**
 * 内置渲染原语（需求13 C2）：divider / hover-card / list / turn-rail /
 * mono-text / none——组合式插件的非第三方渲染件（零外部依赖的纯原语）。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquareText, Wrench } from "lucide-react";
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
