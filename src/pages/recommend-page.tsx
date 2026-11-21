// v0.9.8 需求5（合并版）：装备推荐设置页（管理→推荐）。
// 六键配置 + 重置推荐记忆。文案只述功能（「在会话中为你推荐可能需要的
// 装备」），不述过程（不出现标签匹配/算法等实现词）。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  fetchEquipConfig,
  setEquipConfig,
  type EquipConfig,
} from "@/features/equipment/api";
import { invokeCommand } from "@/hooks/use-invoke";

interface Row {
  key: keyof Omit<EquipConfig, "session_limit">;
  labelKey: string;
  labelFallback: string;
  descKey: string;
  descFallback: string;
}

const TOGGLE_ROWS: Row[] = [
  {
    key: "enabled",
    labelKey: "equip.cfgEnabled",
    labelFallback: "装备推荐",
    descKey: "equip.cfgEnabledDesc",
    descFallback: "在会话、输入框和市场中为你推荐可能需要的装备",
  },
  {
    key: "session_card",
    labelKey: "equip.cfgSessionCard",
    labelFallback: "会话内推荐",
    descKey: "equip.cfgSessionCardDesc",
    descFallback: "任务缺少能力时，在对话中给出可一键安装的推荐卡",
  },
  {
    key: "input_bar",
    labelKey: "equip.cfgInputBar",
    labelFallback: "输入框建议",
    descKey: "equip.cfgInputBarDesc",
    descFallback: "新对话时在输入框上方给出装备建议",
  },
  {
    key: "market_zone",
    labelKey: "equip.cfgMarketZone",
    labelFallback: "市场推荐区",
    descKey: "equip.cfgMarketZoneDesc",
    descFallback: "插件市场按最近任务展示推荐组合",
  },
  {
    key: "third_party",
    labelKey: "equip.cfgThirdParty",
    labelFallback: "包含第三方装备",
    descKey: "equip.cfgThirdPartyDesc",
    descFallback: "关闭后只推荐官方装备",
  },
];

export function RecommendPage() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<EquipConfig | null>(null);
  const [limit, setLimit] = useState(1);
  const [saving, setSaving] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    void fetchEquipConfig().then((c) => {
      setConfig(c);
      setLimit(c.session_limit);
    });
  }, []);

  const toggle = async (key: Row["key"]) => {
    if (!config || saving) return;
    const next = { ...config, [key]: !config[key] };
    setConfig(next);
    setSaving(true);
    try {
      await setEquipConfig({ [key]: next[key] });
    } catch {
      setConfig(config); // 回滚本地态
    } finally {
      setSaving(false);
    }
  };

  const saveLimit = async (n: number) => {
    const clamped = Math.max(1, Math.min(5, n));
    setLimit(clamped);
    if (saving) return;
    setSaving(true);
    try {
      await setEquipConfig({ session_limit: clamped });
    } finally {
      setSaving(false);
    }
  };

  const resetMemory = async () => {
    try {
      await invokeCommand("equip_recommended_clear");
      setResetDone(true);
      setTimeout(() => setResetDone(false), 2000);
    } catch {
      // 失败静默——按钮态不变化即可感知。
    }
  };

  if (!config) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t("common.loading", "加载中…")}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-4" data-recommend-page="">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-[var(--icon-theme)]" />
        <h2 className="text-base font-semibold">{t("equip.cfgTitle", "装备推荐")}</h2>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        {t("equip.cfgSubtitle", "控制各处的装备推荐如何出现")}
      </p>

      <div className="space-y-1.5">
        {TOGGLE_ROWS.map((row) => {
          const value = config[row.key];
          const disabled = saving || (row.key !== "enabled" && !config.enabled);
          return (
            <div
              key={row.key}
              className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground">{t(row.labelKey, row.labelFallback)}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {t(row.descKey, row.descFallback)}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={value}
                disabled={disabled}
                onClick={() => void toggle(row.key)}
                className={cn(
                  "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                  value ? "bg-primary" : "bg-muted-foreground/30",
                  disabled && "opacity-50",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-4 w-4 rounded-full bg-background shadow transition-all",
                    value ? "left-[18px]" : "left-0.5",
                  )}
                />
              </button>
            </div>
          );
        })}

        {/* 每会话推荐上限（1~5）。 */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-xs font-medium text-foreground">{t("equip.cfgLimit", "每个会话的推荐次数")}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {t("equip.cfgLimitDesc", "同一会话内最多出现几次推荐")}
            </div>
          </div>
          <select
            value={limit}
            disabled={saving || !config.enabled || !config.session_card}
            onChange={(e) => void saveLimit(Number(e.target.value))}
            className="h-7 shrink-0 rounded-md border border-border/60 bg-background px-1.5 text-xs outline-none focus:border-primary/50 disabled:opacity-50"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 px-3 py-2.5">
        <div className="min-w-0 text-[11px] text-muted-foreground">
          {resetDone
            ? t("equip.cfgResetDone", "已重置")
            : t("equip.cfgResetDesc", "清除「推荐过未安装」的记录，让推荐重新出现")}
        </div>
        <Button variant="outline" size="sm" className="h-7 shrink-0 px-2 text-[11px]" onClick={() => void resetMemory()}>
          <RotateCcw className="h-3 w-3" />
          {t("equip.cfgReset", "重置推荐记忆")}
        </Button>
      </div>
    </div>
  );
}
