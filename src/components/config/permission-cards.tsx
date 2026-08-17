// v0.7.4 需求2 R2b：权限模式自然语言卡片（替换英文枚举 select）。
// 值仍写 permissions.defaultMode（default/bypassPermissions/plan，
// 值即契约不变），仅呈现层改变；未设置时视同 default。

import { useTranslation } from "react-i18next";
import { Check, ShieldQuestion, ShieldOff, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

export const PERMISSION_MODE_CARDS = [
  {
    value: "default",
    labelKey: "config.permCard.default.title",
    descKey: "config.permCard.default.desc",
    recommended: true,
    icon: ShieldQuestion,
  },
  {
    value: "bypassPermissions",
    labelKey: "config.permCard.bypass.title",
    descKey: "config.permCard.bypass.desc",
    recommended: false,
    icon: ShieldOff,
  },
  {
    value: "plan",
    labelKey: "config.permCard.plan.title",
    descKey: "config.permCard.plan.desc",
    recommended: false,
    icon: MessageSquare,
  },
] as const;

export function PermissionModeCards({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const active = value || "default";
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup">
      {PERMISSION_MODE_CARDS.map((mode) => {
        const Icon = mode.icon;
        const isActive = active === mode.value;
        return (
          <button
            key={mode.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(mode.value)}
            className={cn(
              "rounded-md border p-3 text-left transition-colors",
              isActive
                ? "border-primary/60 bg-primary/10"
                : "border-border/40 hover:border-border bg-background/40",
            )}
          >
            <div className="flex items-center gap-2">
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0",
                  isActive ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className="text-xs font-medium">{t(mode.labelKey)}</span>
              {mode.recommended && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                  {t("config.permCard.recommended")}
                </span>
              )}
              {isActive && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t(mode.descKey)}
            </p>
          </button>
        );
      })}
    </div>
  );
}
