// v0.7.4 R15 死字段整改：jishu 全局行为配置收敛为 Pi Settings 的真实字段。
// 此前此块暴露的 permissions/temperature/maxTokens/thinkingEnabled/
// skipDangerous/verbose/maxTurns 均不在 Pi Settings schema 中（写入无效），
// 已删除。真实的行为控制：
//  - 工具模式（完整/只读）与思考档位即时切换 → 会话页
//  - 全局默认思考档位（defaultThinkingLevel）→ 本块
//  - 默认/激活模型 → 模型设置（models.json + Hub 侧）

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { useAgent } from "@/agents";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Save } from "lucide-react";
import { SectionHelp } from "./section-help";

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function JishuAgentSettingsBlock({
  agentConfig,
  onSaved,
}: {
  agentConfig: Record<string, unknown> | null;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { manageAgentId } = useAgent();
  const agentId = manageAgentId ?? "";

  const saved =
    typeof agentConfig?.defaultThinkingLevel === "string"
      ? (agentConfig.defaultThinkingLevel as string)
      : "";
  const [level, setLevel] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLevel(saved);
  }, [saved]);

  const dirty = level !== saved;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      // 键级覆盖：只写 defaultThinkingLevel，其余字段经合并逻辑保留。
      await invokeCommand("save_config", {
        agentId,
        config: { defaultThinkingLevel: level || null },
      });
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-1.5 sm:max-w-[280px]">
        <Label htmlFor="jishu-default-thinking">
          <span className="inline-flex items-center gap-0.5">
            {t("sessions.thinkingLevel.title")}
            <SectionHelp content={t("config.defaultThinkingLevelHelp")} />
          </span>
        </Label>
        <select
          id="jishu-default-thinking"
          value={
            PI_THINKING_LEVELS.includes(level as (typeof PI_THINKING_LEVELS)[number]) ? level : ""
          }
          onChange={(e) => setLevel(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">{t("sessions.thinkingLevel.unset")}</option>
          {PI_THINKING_LEVELS.map((lvl) => (
            <option key={lvl} value={lvl}>
              {t(`sessions.thinkingLevel.${lvl}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("config.jishuBehaviorHintV3")}
        </p>
      </div>

      <div className="flex items-center justify-end">
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          <Save className="h-3.5 w-3.5" />
          {saving ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}
