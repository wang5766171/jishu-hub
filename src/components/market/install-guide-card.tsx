import { Blocks, Check, KeyRound, Lightbulb, Palette, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * v0.9.8 需求4：安装完成引导卡（三源统一形态）。
 *
 * 「装完即散」改为引导卡：装了什么（名称+类型徽标+一句话说明）/
 * 是否需要配置（缺 API Key 一键到配置位）/ 首次怎么用（示例 prompt）/
 * GUI 适配入口（pi 扩展类：跳会话走创建联动链生成适配件）。
 * 非阻断 toast 卡片，展示期内不自动消失（配置/示例需回看），× 手动关。
 */

export type GuideKind = "plugin" | "skill" | "extension" | "composed";

export interface InstallGuideInfo {
  /** 安装对象标题（插件名/技能名/扩展名）。 */
  title: string;
  kind: GuideKind;
  /** 一句话能力说明。 */
  description: string;
  /** 需要配置（缺 API Key 等）——展示一键到配置位。 */
  requiresApiKey?: boolean;
  /** 首次使用示例（技能类=描述首句改造的建议 prompt；curated 可选 usage_hint）。 */
  usageHint?: string;
  /** GUI 适配入口（pi 扩展类：有后台能力无 hub 呈现）。 */
  guiAdaptable?: boolean;
  /** 需求4 D4-8b：重装/已适配态——界面已有插件提供时改示「界面：将由 XX
      提供」，不再弹适配按钮。 */
  providedBy?: string;
  /** 扩展包名（GUI 适配预填文案用）。 */
  packageName?: string;
}

const KIND_BADGE: Record<GuideKind, { key: string; fallback: string }> = {
  plugin: { key: "market.guideKindPlugin", fallback: "插件" },
  skill: { key: "market.guideKindSkill", fallback: "技能" },
  extension: { key: "market.guideKindExtension", fallback: "扩展" },
  composed: { key: "market.guideKindComposed", fallback: "组合件" },
};

export function InstallGuideCard({
  info,
  onNavigateConfig,
  onGuiAdapt,
  onClose,
}: {
  info: InstallGuideInfo;
  /** 一键到配置位（App 层跳管理页模型/智能体设置）。 */
  onNavigateConfig?: () => void;
  /** GUI 适配：跳会话预填创作指令（v0.9.7 需求3 创建联动链复用）。 */
  onGuiAdapt?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [leaving, setLeaving] = useState(false);
  const badge = KIND_BADGE[info.kind];

  // 关闭动画：300ms 滑出后再卸载（纯视觉，无业务语义）。
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onClose, 280);
    return () => window.clearTimeout(timer);
  }, [leaving, onClose]);

  return (
    <div
      data-install-guide={info.kind}
      className={cn(
        "pointer-events-auto fixed bottom-4 right-4 z-[70] w-80 rounded-xl border border-border bg-popover p-3.5 shadow-xl transition-all duration-300",
        leaving ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100",
      )}
    >
      <div className="flex items-start gap-2">
        <Blocks className="mt-0.5 h-4 w-4 shrink-0 text-[var(--icon-success)]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{info.title}</span>
            <span className="rounded bg-muted px-1.5 py-px text-[11px] text-muted-foreground">
              {t(badge.key, badge.fallback)}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {info.description}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setLeaving(true)}
          title={t("common.close", "关闭")}
          className="rounded-md p-0.5 text-muted-foreground/70 transition-fast hover:bg-accent/60 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {info.requiresApiKey && onNavigateConfig && (
        <button
          type="button"
          onClick={onNavigateConfig}
          className="mt-2.5 flex w-full items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-left text-xs text-foreground transition-fast hover:bg-amber-500/20"
        >
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="flex-1">{t("market.guideNeedConfig", "需要配置：API Key——点击前往配置")}</span>
        </button>
      )}

      {info.usageHint && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
          <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--icon-theme)]" />
          <span className="min-w-0 flex-1">
            <span className="text-foreground/80">{t("market.guideFirstUse", "首次使用")}：</span>
            {info.usageHint}
          </span>
        </div>
      )}

      {info.guiAdaptable && onGuiAdapt && (
        <button
          type="button"
          onClick={onGuiAdapt}
          className="mt-2 flex w-full items-center gap-2 rounded-lg border border-primary/35 bg-primary/8 px-2.5 py-2 text-left text-xs text-foreground transition-fast hover:bg-primary/15"
        >
          <Palette className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="flex-1">{t("market.guideGuiAdapt", "GUI 适配——为这个扩展生成界面插件")}</span>
        </button>
      )}

      {/* 需求4 D4-8b：重装/已适配态——关系已在登记簿，改示由谁提供界面，
          不再弹适配按钮（关系随重装自动恢复）。 */}
      {info.providedBy && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          <span className="min-w-0 flex-1 truncate">
            {t("market.guiProvidedBy", { defaultValue: "界面：将由「{{name}}」提供", name: info.providedBy })}
          </span>
        </div>
      )}
    </div>
  );
}
