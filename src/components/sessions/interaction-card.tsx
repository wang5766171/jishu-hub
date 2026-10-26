import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, MessageCircleQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import { dedupeInteractionItems } from "@/lib/interaction-tools";
import { useBlockRenderers, matchBlockTypeRenderer } from "@/features/session-kernel/plugins/mounts/use-block-renderers";

export interface InteractionCardOption {
  option_id: string;
  label: string;
  description?: string | null;
}

export interface InteractionCardItem {
  prompt: string;
  options?: InteractionCardOption[];
  answer: string;
  selectedOptions?: string[];
}

export interface InteractionCardProps {
  items: InteractionCardItem[];
  origin?: string;
}


export const InteractionCard = memo(function InteractionCard({
  items,
  origin,
  defaultOpen = false,
  renderSource,
}: InteractionCardProps & { defaultOpen?: boolean; renderSource?: string }) {
  // v0.9.4 需求11：origin 仅作透传链字段保留；渲染链路徽标（插件渲染/内置
  // 渲染）显示在卡内 header 折叠箭头左侧（用户裁决位置）。
  void origin;
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const itemsToRender = useMemo(() => dedupeInteractionItems(items), [items]);

  return (
    <div
      className={cn(
        "w-full max-w-full rounded-[6px] border transition-colors",
        open
          ? "border-primary/30 bg-primary/[0.03]"
          : "border-border/50 bg-muted/20 hover:border-border/70",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left select-none"
      >
        <MessageCircleQuestion className="h-4 w-4 shrink-0 text-primary/70" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {t("sessions.interactionDefault", { defaultValue: "Ask user" })}
        </span>
        {renderSource && (
          <span className="inline-flex shrink-0 items-center rounded-full bg-muted/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {renderSource}
          </span>
        )}
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="space-y-4 border-t border-border/30 px-3 py-2.5">
          {itemsToRender.map((item, idx) => (
            <div key={idx} className="space-y-1.5">
              <p className="text-sm leading-relaxed text-muted-foreground">
                {item.prompt}
              </p>
              {/* v0.9.4 需求11：保留选项列表（用户裁决：回放与会话流式过程
                  渲染统一）——选项只读展示，已选高亮（selectedOptions 命中
                  option_id 或 answer 文本匹配 label）。 */}
              {item.options && item.options.length > 0 && (
                <div className="space-y-1">
                  {item.options.map((opt) => {
                    const selected = item.selectedOptions?.includes(opt.option_id)
                      || (item.answer ? item.answer.includes(opt.label) : false);
                    return (
                      <div
                        key={opt.option_id}
                        className={cn(
                          "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-sm",
                          selected
                            ? "border-primary/50 bg-primary/[0.06] text-foreground"
                            : "border-border/40 bg-muted/10 text-muted-foreground",
                        )}
                      >
                        <span
                          className={cn(
                            "mt-[3px] inline-block h-3.5 w-3.5 shrink-0 rounded-full border",
                            selected ? "border-primary bg-primary/80" : "border-muted-foreground/40",
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className={cn("block", selected && "font-medium")}>{opt.label}</span>
                          {opt.description && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">{opt.description}</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* v0.9.4 需求11 补（用户实测：选中项高亮与答案行重复）：
                  答案行仅当无法由选项高亮表达时显示——已选选项高亮已承载
                  「答了什么」；自定义文本回答（不匹配任何选项）或无选项时
                  才显示答案文本行。 */}
              {(() => {
                const selectedHit = (item.options ?? []).some((opt) =>
                  item.selectedOptions?.includes(opt.option_id)
                  || (item.answer ? item.answer.includes(opt.label) : false),
                );
                const showAnswerLine = !selectedHit;
                if (!showAnswerLine) return null;
                return (
                  <p className="whitespace-pre-wrap text-sm font-semibold leading-relaxed text-foreground">
                    {item.answer || (
                      <span className="font-normal italic text-muted-foreground">
                        {t("sessions.interactionNoAnswer", { defaultValue: "(No answer)" })}
                      </span>
                    )}
                  </p>
                );
              })()}
            </div>
          ))}

          {/* v0.9.4 需求11（用户裁决）：origin 来源徽标不再显示——「内置助手」
              等文案对用户无信息量（内部概念），展开态本就聚焦问题/选项/答案。 */}
        </div>
      )}
    </div>
  );
});

/**
 * v0.9.4 需求11（修正版，用户裁决：不得移除插件接管机制）：interaction 块的
 * 统一渲染入口——插件 blockTypes 咨询优先（v0.9.3 需求2 P1-2 / 需求10 B1
 * 机制保留），未命中回退内置 InteractionCard。**流式与回放两侧共用本组件**
 *（此前插件只在回放侧生效、流式侧恒内置——正是「过程与结束不一致」的
 * 根源；两侧同链后插件命中/未命中都一致）。
 * defaultOpen 仅作用于内置卡回退分支（回放 true 保留选项可见；流式 false
 * 保持折叠交互）；插件 Block 的展开行为由插件自决。
 */
export function InteractionBlockWithRenderers({
  items,
  origin,
  defaultOpen = false,
}: {
  items: InteractionCardItem[];
  origin?: string;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const renderers = useBlockRenderers();
  const renderer = matchBlockTypeRenderer(renderers, "interaction");
  // v0.9.4 需求11（用户裁决）：徽标区分**渲染链路**（插件渲染/内置渲染）
  // ——替换原 agent 来源徽标（「内置助手/外部助手」文案让用户误解）。
  // 统一由本组件外层渲染，任何插件 Block（不止委托卡）都带来源标识。
  const sourceBadge = renderer
    ? t("sessions.renderSourcePlugin", { defaultValue: "插件渲染" })
    : t("sessions.renderSourceBuiltin", { defaultValue: "内置渲染" });
  if (renderer) {
    const Block = renderer.BlockComponent;
    // 徽标经 PluginBlock.renderSource 透传（插件委托卡时由插件渲染在卡内
    // header 箭头左侧；见 interaction-render 插件委托实现）。
    return (
      <>
        {items.map((item, idx) => (
          <Block
            key={idx}
            block={{
              type: "interaction",
              text: item.prompt,
              options: (item.options ?? []).map((o) => ({ id: o.option_id, label: o.label })),
              answer: item.answer || undefined,
              origin,
              renderSource: sourceBadge,
            }}
          />
        ))}
      </>
    );
  }
  return <InteractionCard items={items} origin={origin} defaultOpen={defaultOpen} renderSource={sourceBadge} />;
}
