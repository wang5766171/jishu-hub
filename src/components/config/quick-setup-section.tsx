// v0.7.4 需求2 R2a：claude 快速配置区（代理服务商引导）。
// 面向普通用户的主路径：选服务商卡片 → 填 API Key → 自动写 env
// （ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL）。
// 已配置代理时显示状态条并支持「还原官方直连」；连通性测试统一走
// 配置页顶部的「测试连接」按钮（R2c），此处不重复入口。
// 显隐由 surface.supports_proxy_setup 门控（DEVELOP_READ §5，无 agentId 分支）。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, ExternalLink, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CLAUDE_PROXY_PRESETS,
  applyProxyPresetToEnv,
  removeProxyEnv,
  type ClaudeProxyPreset,
} from "@/agents/config/presets/claude-presets";

export function QuickSetupSection({
  env,
  model,
  onEnvChange,
  onModelChange,
}: {
  /** 当前配置草稿的 env（全量） */
  env: Record<string, string>;
  /** 当前配置草稿的主模型 */
  model: string;
  onEnvChange: (env: Record<string, string>) => void;
  onModelChange: (model: string) => void;
}) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");

  const proxyBaseUrl = env["ANTHROPIC_BASE_URL"]?.trim() || "";
  const activePreset: ClaudeProxyPreset | undefined = CLAUDE_PROXY_PRESETS.find(
    (p) => !p.custom && p.baseUrl === proxyBaseUrl,
  );

  const choosePreset = (preset: ClaudeProxyPreset) => {
    if (preset.custom) return;
    // 首次写入时同步推荐模型（用户此后手动改模型不被覆盖）
    const nextEnv = applyProxyPresetToEnv(preset, apiKey, env);
    onEnvChange(nextEnv);
    if (preset.model && !model) onModelChange(preset.model);
  };

  const clearProxy = () => {
    onEnvChange(removeProxyEnv(env));
  };

  return (
    <div className="rounded-md border border-border/40 bg-muted/20 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{t("config.quickSetupTitle")}</div>
          <div className="text-[11px] text-muted-foreground">{t("config.quickSetupDesc")}</div>
        </div>
        {activePreset && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
              <Check className="h-3 w-3" />
              {t("config.quickSetupActive", { provider: t(activePreset.labelKey) })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-muted-foreground"
              onClick={clearProxy}
              title={t("config.quickSetupClearHint")}
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              {t("config.quickSetupClear")}
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {CLAUDE_PROXY_PRESETS.map((p) => {
          const active = activePreset?.id === p.id;
          return (
            <button
              key={p.id}
              type="button"
              disabled={p.custom}
              onClick={() => choosePreset(p)}
              className={cn(
                "rounded-md border px-3 py-2 text-left transition-colors",
                p.custom
                  ? "cursor-default border-dashed border-border/30 text-muted-foreground/60"
                  : active
                    ? "border-primary/60 bg-primary/10"
                    : "border-border/40 hover:border-border bg-background/40",
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-medium truncate">{t(p.labelKey)}</span>
                {active && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
              </div>
              {p.model && (
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground font-mono">
                  {p.model}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1 space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="quick-apikey">{t("config.apiKey")}</Label>
            {activePreset?.apiKeyUrl && (
              <a
                href={activePreset.apiKeyUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
              >
                {t("config.presetGetKey")}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <Input
            id="quick-apikey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("config.quickSetupKeyPlaceholder")}
            autoComplete="off"
          />
        </div>
        <Button
          size="sm"
          className="h-9"
          disabled={!activePreset || !apiKey.trim()}
          onClick={() => {
            if (!activePreset) return;
            onEnvChange(applyProxyPresetToEnv(activePreset, apiKey, env));
          }}
        >
          {t("config.quickSetupApplyKey")}
        </Button>
      </div>

      <p className="text-[10px] text-muted-foreground/70">
        {t("config.quickSetupOfficialHint")}
      </p>
    </div>
  );
}
