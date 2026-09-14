import { useTranslation } from "react-i18next";
import { CheckCircle2, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor, PluginBlock } from "../types";

/**
 * 交互问答卡渲染插件（v0.9.2 底座增强后首批拆出；v0.9.3 需求2 完成接线）：
 * 经 blockTypes: ["interaction"] 声明接管 interaction 块渲染——message-view
 * 三个渲染点（renderBlock / 助手气泡分组项 / 用户侧气泡分组项）统一经
 * InteractionBlockWithRenderers 行级咨询，未启用/未命中时回退内置
 * InteractionCard，插件页开关真实生效。detect/Component（代码块路径）不接管。
 */

function InteractionBlockRenderer({ block }: { block: PluginBlock }) {
  const { t } = useTranslation();
  const prompt = block.text ?? "";
  const options = block.options ?? [];
  const answer = block.answer;

  return (
    <div className="my-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-start gap-2.5">
        <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{prompt}</div>
          {options.length > 0 && (
            <div className="mt-2 space-y-1">
              {options.map((opt) => {
                const selected = answer === opt.label || answer === opt.id;
                return (
                  <div
                    key={opt.id}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
                      selected
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-border/40 text-muted-foreground",
                    )}
                  >
                    {selected ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />
                    ) : (
                      <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-border" />
                    )}
                    <span>{opt.label}</span>
                  </div>
                );
              })}
            </div>
          )}
          {answer && !options.some((o) => o.label === answer) && (
            <div className="mt-2 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5 text-xs text-foreground/80">
              <span className="font-medium text-muted-foreground">
                {t("sessionPlugins.interaction.answer", "已答")}：
              </span>
              {answer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const interactionRenderPlugin: SessionPluginDescriptor = {
  id: "session.interaction-render",
  displayNameKey: "sessionPlugins.interaction.name",
  displayNameFallback: "交互问答卡",
  descriptionKey: "sessionPlugins.interaction.description",
  descriptionFallback: "消息中交互问答块的卡片化渲染（流式路径仍在核心）",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:messages"],
  mounts: [
    {
      kind: "block-renderer",
      languages: [],
      detect: () => false, // 不匹配代码块
      Component: () => null, // 代码块路径不接管
      blockTypes: ["interaction"],
      BlockComponent: InteractionBlockRenderer,
    },
  ],
};
