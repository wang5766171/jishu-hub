// v0.7.4 需求2：配置页统一骨架（jishu / claude 共用）。
// R3 三区式单页 → R4 拆为侧边栏导航的独立子页（模型设置 / 行为与权限 /
// 配置模版 / 高级设置），本组件只保留页头（switcher + 状态 + 动作槽）与
// 子页标题。纯呈现层：加载哪个页面、子页内容仍由 ConfigSurface /
// capability 组合决定（DEVELOP_READ §5/§8，无 agentId 分支）。

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { AgentConfigSection } from "@/types";
import { SectionHelp } from "./section-help";

/** 子页标题/描述 i18n 键（structured 与 model_store 两类页面共用）。 */
export const CONFIG_SECTION_META: Record<
  AgentConfigSection,
  { titleKey: string; descKey: string }
> = {
  models: { titleKey: "manage.menuModels", descKey: "manage.pageDescModels" },
  behavior: { titleKey: "manage.menuBehavior", descKey: "config.jishuBehaviorHintV3" },
  templates: { titleKey: "manage.menuTemplates", descKey: "manage.pageDescTemplates" },
  backups: { titleKey: "manage.menuBackups", descKey: "manage.pageDescBackups" },
  advanced: { titleKey: "manage.menuAdvanced", descKey: "manage.pageDescAdvanced" },
};

export function ConfigPageShell({
  statusSlot,
  switcherSlot,
  actionsSlot,
  title,
  description,
  children,
}: {
  /** agent 健康徽标等状态区 */
  statusSlot?: ReactNode;
  /** AgentSwitcher 槽 */
  switcherSlot?: ReactNode;
  /** 页头右侧动作区（保存/测试按钮等，R4 从表单 sticky 头移入） */
  actionsSlot?: ReactNode;
  /** 子页标题（模型设置 / 行为与权限 / …） */
  title?: string;
  /** 子页一句话描述 */
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col p-6">
      <div className="flex items-center justify-between gap-3 pb-2">
        <div className="flex items-center gap-3">
          {switcherSlot}
          {statusSlot}
        </div>
      </div>
      {/* v0.8.0 需求9 收尾：actionsSlot 与大标题同行右侧（用户裁决），
          保存/测试等页级动作不再悬浮在切换器行。 */}
      {title && (
        <div className="flex items-start justify-between gap-3 pb-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
            {description && (
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            )}
          </div>
          {actionsSlot && <div className="shrink-0 pt-0.5">{actionsSlot}</div>}
        </div>
      )}
      {/* px-1：滚动容器两侧留 4px，避免贴边元素的焦点环（绘制在边框外
          1px）被 overflow 裁掉——如 MCP JSON 输入框左侧蓝框缺失。 */}
      <div className="flex-1 min-h-0 space-y-5 overflow-y-auto px-1">{children}</div>
    </div>
  );
}

/** 高级子页内的子块标题（env / MCP / 模板…）。help 渲染为标题行内的「？」气泡（R5）。 */
export function AdvancedBlock({
  title,
  help,
  children,
}: {
  title: string;
  /** 字段映射等帮助文案，弹泡展示 */
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {title}
        {help && <SectionHelp content={help} />}
      </div>
      {children}
    </div>
  );
}

/** agent 健康徽标（页头状态区）。R6：背景/文字走主题语义色，仅圆点保留状态色。 */
export function AgentStatusBadge({
  installed,
  version,
}: {
  installed: boolean;
  version?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-foreground/80",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          installed ? "bg-emerald-500" : "bg-red-500",
        )}
      />
      {installed
        ? `${t("status.installed")}${version ? ` · ${version}` : ""}`
        : t("status.notInstalled")}
    </span>
  );
}
