// v0.7.6 需求3：模型设置页统一左栏（渠道侧栏）。
// jishu / claude / codex 三页共用——官方直连项（可选）+ 预置渠道（默认
// 全量显示）+ 自定义渠道 + 底部「添加自定义渠道」按钮；选中/激活绿点
// 交互与原 jishu ModelManager 左栏一致（240px、圆角卡片列表）。
// 组件无业务状态：数据组装与点击行为全部由调用方注入。

import { useTranslation } from "react-i18next";
import { Loader2, Plus, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ChannelSidebarItem {
  /** 渠道 id（预置 = 预设 id；自定义 = provider key / "custom"） */
  id: string;
  label: string;
  /** 副文本（baseUrl 等，一行截断） */
  sub?: string;
  /** 当前生效（绿点） */
  active?: boolean;
  /** 已添加但未激活（预置渠道在 jishu 中的形态：弱化边框提示可进入） */
  added?: boolean;
}

export function ChannelSidebar({
  loading = false,
  emptyHint,
  directLabel,
  directActive = false,
  directSelected = false,
  onSelectDirect,
  channels,
  selectedId,
  onSelect,
  onAddCustom,
}: {
  loading?: boolean;
  /** 渠道列表为空时的空态文案 */
  emptyHint?: string;
  /** 官方直连项文案（不传 = 无直连概念，如 jishu） */
  directLabel?: string;
  directActive?: boolean;
  directSelected?: boolean;
  onSelectDirect?: () => void;
  channels: ChannelSidebarItem[];
  /** 当前选中项 id；官方直连的保留 id 为 "direct" */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 底部「添加自定义渠道」按钮（不传 = 不渲染） */
  onAddCustom?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      <span className="block text-xs font-medium text-muted-foreground">
        {t("config.colChannels")}
      </span>
      <div className="space-y-1 rounded-lg border border-border/40 p-1.5">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> {t("common.loading")}
          </div>
        ) : (
          <>
            {directLabel && onSelectDirect && (
              <button
                type="button"
                onClick={onSelectDirect}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-fast",
                  directSelected
                    ? "bg-primary/15 font-medium text-primary shadow-[inset_2px_0_0_0_currentColor]"
                    : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                )}
              >
                <Zap
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    directActive ? "text-emerald-500" : "text-muted-foreground/60",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{directLabel}</span>
                </span>
                {directActive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />}
              </button>
            )}
            {channels.length === 0 && !directLabel ? (
              <p className="px-2 py-3 text-center text-[11px] leading-relaxed text-muted-foreground/70">
                {emptyHint ?? t("config.noProviders")}
              </p>
            ) : (
              channels.map((channel) => {
                const isSelected = selectedId === channel.id;
                return (
                  <button
                    key={channel.id}
                    type="button"
                    onClick={() => onSelect(channel.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-fast",
                      isSelected
                        ? "bg-primary/15 font-medium text-primary shadow-[inset_2px_0_0_0_currentColor]"
                        : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        channel.active ? "bg-emerald-500" : "bg-transparent",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{channel.label}</span>
                      {channel.sub && (
                        <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
                          {channel.sub}
                        </span>
                      )}
                    </span>
                    {channel.added && !channel.active && (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {t("config.channelAdded")}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </>
        )}
      </div>
      {onAddCustom && (
        <button
          type="button"
          onClick={onAddCustom}
          className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/60 px-2 py-1.5 text-xs text-muted-foreground transition-fast hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          {t("config.channelAddCustom")}
        </button>
      )}
    </div>
  );
}
