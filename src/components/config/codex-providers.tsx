// v0.7.5 需求7：codex 渠道管理块（模型设置页，supports_model_providers 声明驱动）。
// 数据形状 = codex config.toml 原生键：顶层 model_provider（直连=null / 中转=provider id）
// + [model_providers.*]（name/base_url/wire_api="responses"/env_key），密钥存于
// config env（经 env_key 名），spawn 时由 codex_spawn_envs 注入进程环境。
// 迭代五（用户反馈）：布局完全对齐 claude——左右双栏（左渠道设置 240px、
// 右模型设置+接入配置），官方直连在前；直连态提示用 codex 文案。

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { CODEX_PROXY_PRESETS } from "@/agents/config/presets/codex-presets";

type ProviderEntry = {
  name?: string;
  base_url?: string;
  wire_api?: string;
  env_key?: string;
};

export function CodexProvidersBlock({
  modelProvider,
  modelProviders,
  env,
  modelCard,
  onChange,
}: {
  modelProvider: string | null | undefined;
  modelProviders: Record<string, unknown> | null | undefined;
  env: Record<string, string> | null | undefined;
  /** 模型卡（由 ConfigModelsZone 组装传入——右栏「模型设置」，对齐 claude） */
  modelCard: ReactNode;
  onChange: (patch: {
    modelProvider?: string | null;
    modelProviders?: Record<string, unknown> | null;
    env?: Record<string, string>;
    model?: string | null;
  }) => void;
}) {
  const { t } = useTranslation();
  // 本地选中渠道（右侧展示其接入配置）；默认跟随激活渠道。
  const [selectedId, setSelectedId] = useState(
    modelProvider ?? CODEX_PROXY_PRESETS[0]?.id ?? "",
  );
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");

  const providers = (modelProviders ?? {}) as Record<string, ProviderEntry>;
  const envMap = env ?? {};
  const showProxy = Boolean(modelProvider);

  /** 左栏渠道清单：预设渠道 + 已建的非预设自定义渠道。 */
  const channels: Array<{ id: string; label: string }> = [
    ...CODEX_PROXY_PRESETS.map((p) => ({ id: p.id, label: t(p.labelKey) })),
    ...Object.entries(providers)
      .filter(([id]) => !CODEX_PROXY_PRESETS.some((p) => p.id === id))
      .map(([id, entry]) => ({ id, label: (entry as ProviderEntry).name || id })),
  ];
  const selectedPreset = CODEX_PROXY_PRESETS.find((p) => p.id === selectedId);
  const selectedProvider = providers[selectedId];
  const selectedLabel =
    channels.find((c) => c.id === selectedId)?.label ?? selectedId;

  /** 应用预设渠道：生成/覆盖渠道并激活；模型为空时带入预设默认模型。 */
  const applyPreset = (presetId: string) => {
    setSelectedId(presetId);
    const preset = CODEX_PROXY_PRESETS.find((p) => p.id === presetId);
    if (!preset || preset.id === "custom") return;
    onChange({
      modelProvider: preset.id,
      modelProviders: {
        ...providers,
        [preset.id]: {
          name: t(preset.labelKey),
          base_url: preset.baseUrl,
          wire_api: "responses",
          env_key: preset.envKey,
        },
      },
    });
  };

  const activeEnvKey = selectedProvider?.env_key ?? selectedPreset?.envKey ?? "API_KEY";
  const savedKey = envMap[activeEnvKey] ?? "";

  return (
    <div className="space-y-4">
      {/* 接入方式切换：官方直连在前、配置代理在后（迭代四用户裁决） */}
      <div className="inline-flex rounded-lg border border-border/60 bg-muted/20 p-0.5">
        <button
          type="button"
          onClick={() => modelProvider && onChange({ modelProvider: null })}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium transition-fast",
            !showProxy ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("config.connectDirect")}
        </button>
        <button
          type="button"
          onClick={() => {
            // 无渠道时进入代理态 = 应用第一个预设（DeepSeek），保证切换有实际效果
            const fallback = modelProvider ?? CODEX_PROXY_PRESETS.find((p) => p.id !== "custom")?.id;
            if (fallback) applyPreset(fallback);
          }}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium transition-fast",
            showProxy ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("config.connectProxy")}
        </button>
      </div>

      {!showProxy ? (
        /* 直连：codex 专属提示 + 模型设置（对齐 claude 直连态结构） */
        <div className="space-y-3">
          <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
            {t("config.codexDirectHint")}
          </div>
          {modelCard}
        </div>
      ) : (
        /* 代理：左渠道设置，右模型设置（对齐 claude 双栏结构） */
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">{t("config.colChannels")}</div>
            <div className="space-y-1 rounded-lg border border-border/40 p-1.5">
              {channels.map((channel) => {
                const isActive = modelProvider === channel.id;
                const isSelected = selectedId === channel.id;
                return (
                  <button
                    key={channel.id}
                    type="button"
                    onClick={() => (channel.id === "custom" ? setSelectedId(channel.id) : applyPreset(channel.id))}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-fast",
                      isSelected
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        isActive ? "bg-emerald-500" : "bg-transparent",
                      )}
                    />
                    <span className="truncate">{channel.label}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] leading-relaxed text-muted-foreground/70">
              {t("config.channelPickHint")}
            </p>
          </div>

          <div className="space-y-4">
            <div className="text-xs font-medium text-muted-foreground">{t("config.colModels")}</div>
            {modelCard}

            {/* 选中渠道的接入配置（对齐 claude 右栏卡） */}
            {selectedId === "custom" ? (
              <div className="space-y-3 rounded-md border border-border/40 bg-muted/20 p-4">
                <div className="text-sm font-medium">{t("config.preset.custom.name")}</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("config.codexCustomChannelHint")}
                </p>
                <CustomChannelForm
                  providers={providers}
                  onCreate={(id, entry, key, model) => {
                    setSelectedId(id);
                    onChange({
                      modelProvider: id,
                      modelProviders: { ...providers, [id]: entry },
                      env: { ...envMap, [entry.env_key ?? `${id.toUpperCase()}_API_KEY`]: key },
                      ...(model ? { model } : {}),
                    });
                  }}
                />
              </div>
            ) : selectedProvider || selectedPreset ? (
              <div className="space-y-3 rounded-md border border-border/40 bg-muted/20 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">{selectedLabel}</div>
                  {modelProvider === selectedId && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                      <Check className="h-3 w-3" />
                      {t("config.channelActive")}
                    </span>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label>{t("config.baseUrl")}</Label>
                  <code className="block truncate rounded bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">
                    {selectedProvider?.base_url ?? selectedPreset?.baseUrl ?? ""}
                  </code>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="codex-channel-apikey">{t("config.apiKey")}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="codex-channel-apikey"
                      type={showKey ? "text" : "password"}
                      value={keyDraft}
                      onChange={(e) => setKeyDraft(e.target.value)}
                      placeholder={t("config.quickSetupKeyPlaceholder")}
                      autoComplete="off"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      onClick={() => setShowKey((v) => !v)}
                      title={showKey ? t("config.hideKey") : t("config.showKey")}
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                    <Button
                      size="sm"
                      className="h-9 shrink-0"
                      disabled={!keyDraft.trim()}
                      onClick={() => {
                        onChange({ env: { ...envMap, [activeEnvKey]: keyDraft.trim() } });
                        setKeyDraft("");
                      }}
                    >
                      {t("config.quickSetupApplyKey")}
                    </Button>
                  </div>
                  {savedKey && (
                    <p className="text-[10px] text-muted-foreground/70">
                      {t("config.channelKeySaved")}
                      {savedKey.length > 8 ? `：••••${savedKey.slice(-4)}` : ""}
                    </p>
                  )}
                </div>
                <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                  {t("config.proxyResponsesHint")}
                </p>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/** 自定义渠道表单：标识 / 端点 / 模型 / 密钥 → 创建并激活。 */
function CustomChannelForm({
  providers,
  onCreate,
}: {
  providers: Record<string, ProviderEntry>;
  onCreate: (id: string, entry: ProviderEntry, key: string, model: string) => void;
}) {
  const { t } = useTranslation();
  const [id, setId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [key, setKey] = useState("");

  const inputClass = "h-8 text-sm";
  const valid = id.trim() && baseUrl.trim();

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">{t("config.proxyIdPlaceholder")}</Label>
          <Input className={inputClass} value={id} onChange={(e) => setId(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("config.modelId")}</Label>
          <Input
            className={inputClass}
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder={t("config.modelIdPlaceholder")}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Base URL</Label>
        <Input
          className={inputClass}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("config.apiKey")}</Label>
        <Input
          className={inputClass}
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t("config.quickSetupKeyPlaceholder")}
          autoComplete="off"
        />
      </div>
      <Button
        size="sm"
        className="h-8"
        disabled={!valid || Boolean(providers[id.trim()])}
        onClick={() => {
          const trimmed = id.trim();
          const envKey = `${trimmed.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
          onCreate(
            trimmed,
            {
              name: trimmed,
              base_url: baseUrl.trim(),
              wire_api: "responses",
              env_key: envKey,
            },
            key.trim(),
            modelId.trim(),
          );
          setId("");
          setBaseUrl("");
          setModelId("");
          setKey("");
        }}
      >
        {t("config.quickSetupApplyKey")}
      </Button>
    </div>
  );
}
