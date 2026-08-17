// v0.7.4 需求2 R2b/R3：模式卡片。R3 起泛化为通用 ModeCards——
// claude 权限三卡与 jishu 工具模式两卡共用同一交互（点选即存），
// 值即契约不变（default/bypassPermissions/plan、full/readonly）。

import { useTranslation } from "react-i18next";
import { Check, MessageSquare, ShieldOff, ShieldQuestion, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ModeCardOption {
  value: string;
  labelKey: string;
  descKey?: string;
  recommended?: boolean;
  icon?: "shieldQuestion" | "shieldOff" | "messageSquare" | "shieldCheck";
}

const ICONS = {
  shieldQuestion: ShieldQuestion,
  shieldOff: ShieldOff,
  messageSquare: MessageSquare,
  shieldCheck: ShieldCheck,
} as const;

export function ModeCards({
  options,
  value,
  onChange,
  columns,
}: {
  options: ModeCardOption[];
  /** 当前值；空字符串视同第一个选项（各家的默认语义） */
  value: string;
  onChange: (value: string) => void;
  /** 卡片列数（默认 = 选项数，1~3） */
  columns?: number;
}) {
  const { t } = useTranslation();
  const active = value || options[0]?.value || "";
  const cols = columns ?? Math.min(Math.max(options.length, 1), 3);
  const colClass =
    cols === 1 ? "grid-cols-1" : cols === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-3";
  return (
    <div className={cn("grid gap-2", colClass)} role="radiogroup">
      {options.map((mode) => {
        const Icon = mode.icon ? ICONS[mode.icon] : undefined;
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
              {Icon && (
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    isActive ? "text-primary" : "text-muted-foreground",
                  )}
                />
              )}
              <span className="text-xs font-medium">{t(mode.labelKey)}</span>
              {mode.recommended && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                  {t("config.permCard.recommended")}
                </span>
              )}
              {isActive && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
            </div>
            {mode.descKey && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {t(mode.descKey)}
              </p>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** claude 权限三卡（R2b 交付，值仍写 permissions.defaultMode）。 */
export const PERMISSION_MODE_CARDS: ModeCardOption[] = [
  {
    value: "default",
    labelKey: "config.permCard.default.title",
    descKey: "config.permCard.default.desc",
    recommended: true,
    icon: "shieldQuestion",
  },
  {
    value: "bypassPermissions",
    labelKey: "config.permCard.bypass.title",
    descKey: "config.permCard.bypass.desc",
    icon: "shieldOff",
  },
  {
    value: "plan",
    labelKey: "config.permCard.plan.title",
    descKey: "config.permCard.plan.desc",
    icon: "messageSquare",
  },
];

export function PermissionModeCards({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return <ModeCards options={PERMISSION_MODE_CARDS} value={value} onChange={onChange} />;
}

/** jishu 工具模式两卡（R3：写 Hub agent_tool_mode，完整/只读）。 */
export const TOOL_MODE_CARDS: ModeCardOption[] = [
  {
    value: "full",
    labelKey: "config.toolMode.full.title",
    descKey: "config.toolMode.full.desc",
    recommended: true,
    icon: "shieldCheck",
  },
  {
    value: "readonly",
    labelKey: "config.toolMode.readonly.title",
    descKey: "config.toolMode.readonly.desc",
    icon: "shieldQuestion",
  },
];
