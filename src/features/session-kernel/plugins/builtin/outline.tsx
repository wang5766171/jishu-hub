/**
 * 会话大纲插件（v0.9.3 需求10 / B3，规划目标2「会话大纲」条件已具备项：
 * turns() + scrollToTurn）：dock-panel 列出每轮问答大纲（提问首行 + 回答
 * 摘要），点击滚动定位到对应轮——长会话的结构化导航。数据/命令全部来自
 * 受控上下文，零 IPC。
 */
import { useTranslation } from "react-i18next";
import { MessageSquareText } from "lucide-react";
import { cn } from "@/lib/utils";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor, SessionKernelContext } from "../types";

function outlineLine(text: string, max = 46): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function OutlinePanel({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  if (ctx.turns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        {t("sessionPlugins.outline.empty", "暂无对话轮次")}
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto p-2">
      {ctx.turns.map((turn, index) => {
        const active = index === ctx.activeTurnIndex;
        return (
          <button
            key={index}
            type="button"
            onClick={() => ctx.scrollToTurn(index)}
            className={cn(
              "mb-1 flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors",
              active ? "bg-accent/60" : "hover:bg-accent/40",
            )}
          >
            <MessageSquareText
              className={cn(
                "mt-0.5 h-3 w-3 shrink-0",
                active ? "text-primary" : "text-muted-foreground/60",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className={cn("block text-[11px] leading-snug", active ? "text-foreground font-medium" : "text-foreground/80")}>
                {outlineLine(turn.question) || t("sessionPlugins.outline.untitled", "（未命名轮次）")}
              </span>
              {turn.answer ? (
                <span className="block truncate text-[10px] leading-snug text-muted-foreground/70">
                  {outlineLine(turn.answer, 38)}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export const outlinePlugin: SessionPluginDescriptor = {
  id: "session.outline",
  displayNameKey: "sessionPlugins.outline.name",
  displayNameFallback: "会话大纲",
  descriptionKey: "sessionPlugins.outline.description",
  descriptionFallback: "面板列出每轮问答大纲，点击跳转到对应轮次",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:turns"],
  mounts: [
    {
      kind: "dock-panel",
      titleKey: "sessionPlugins.outline.panelTitle",
      titleFallback: "会话大纲",
      Component: OutlinePanel,
      defaultSlot: "float",
    },
  ],
};
