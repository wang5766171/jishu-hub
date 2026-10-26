import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionKernelContext, SessionPluginDescriptor, PluginSearchMatch } from "../types";

/**
 * 消息搜索插件（v0.9.2 底座增强后首批拆出）：
 * 原为 chat-page 内嵌搜索 UI（useMessageSearch + 头部搜索框），现迁移为
 * dock-panel 插件——消费 ctx.searchMessages / ctx.scrollToMessage（底座增强
 * 的命令面）。支持命中列表 + 上下导航。
 */

function SearchPanelBody({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PluginSearchMatch[]>([]);
  const [current, setCurrent] = useState(0);

  const doSearch = (q: string) => {
    setQuery(q);
    const result = ctx.searchMessages(q);
    setMatches(result);
    setCurrent(0);
  };

  const jump = (index: number) => {
    if (matches.length === 0) return;
    const clamped = Math.max(0, Math.min(index, matches.length - 1));
    setCurrent(clamped);
    ctx.scrollToMessage(matches[clamped].messageIndex);
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => doSearch(e.target.value)}
          placeholder={t("sessionPlugins.search.placeholder", "搜索消息…")}
          className="min-w-0 flex-1 rounded-md border border-border/50 bg-background px-2 py-1 text-xs outline-none focus:border-primary/40"
        />
        {matches.length > 0 && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {current + 1}/{matches.length}
          </span>
        )}
        {matches.length > 1 && (
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => jump(current - 1)}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent"
            >
              <ChevronUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => jump(current + 1)}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
      {matches.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {matches.slice(0, 50).map((match, i) => (
            <button
              key={i}
              type="button"
              onClick={() => jump(i)}
              className={cn(
                "mb-1 block w-full rounded-md px-2 py-1.5 text-left transition-colors",
                i === current ? "bg-primary/10" : "hover:bg-accent/50",
              )}
            >
              <div className="text-[10px] text-muted-foreground">
                {t("sessionPlugins.search.messageIndex", "消息")} {match.messageIndex + 1}
              </div>
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-foreground/80">
                {match.excerpt}
              </div>
            </button>
          ))}
        </div>
      )}
      {query && matches.length === 0 && (
        <div className="px-2 pb-2 text-center text-muted-foreground">
          {t("sessionPlugins.search.noResults", "无匹配结果")}
        </div>
      )}
    </div>
  );
}

export const messageSearchPlugin: SessionPluginDescriptor = {
  id: "session.search",
  displayNameKey: "sessionPlugins.search.name",
  displayNameFallback: "消息搜索",
  descriptionKey: "sessionPlugins.search.description",
  descriptionFallback: "搜索当前会话消息内容并跳转定位",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:messages", "command:scroll"],
  mounts: [
    {
      kind: "dock-panel",
      titleKey: "sessionPlugins.search.panelTitle",
      titleFallback: "搜索",
      Component: SearchPanelBody,
      defaultSlot: "float",
    },
  ],
};
