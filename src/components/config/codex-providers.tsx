// v0.7.5 需求7：codex 渠道管理块（模型设置页，supports_model_providers 声明驱动）。
// 数据形状 = codex config.toml 原生键：顶层 model_provider（直连=null / 中转=provider id）
// + [model_providers.*]（name/base_url/wire_api/env_key），密钥存于 config env
//（经 env_key 名），spawn 时由 codex_spawn_envs 注入进程环境。
// v0.7.6 需求3：布局统一 ChannelSidebar——左栏官方直连 + 预置渠道（默认全量
// 显示）+ 自定义渠道 + 底部「添加自定义渠道」；wire_api 按预设声明（百炼/KIMI
// 为 chat completions 兼容端点，其余 responses）；渠道卡补「获取密钥」外链。

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useCodexLiveModels } from "@/hooks/use-codex-live-models";
import { invokeCommand } from "@/hooks/use-invoke";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, ExternalLink, Eye, EyeOff, Plus, Power, Trash2 } from "lucide-react";
import {
  CODEX_PROXY_PRESETS,
  codexCustomModelsFor,
  rememberCodexCustomModel,
  removeCodexCustomModel,
} from "@/agents/config/presets/codex-presets";
import { ChannelSidebar, type ChannelSidebarItem } from "./channel-sidebar";
import { OfficialAuthCard } from "./official-auth-card";

type ProviderEntry = {
  name?: string;
  base_url?: string;
  wire_api?: string;
  env_key?: string;
};

export function CodexProvidersBlock({
  model,
  modelProvider,
  modelProviders,
  env,
  modelCard,
  agentId,
  onChange,
}: {
  /** 当前模型（config.model；切渠道时做模型联动判断） */
  model: string | null | undefined;
  modelProvider: string | null | undefined;
  modelProviders: Record<string, unknown> | null | undefined;
  env: Record<string, string> | null | undefined;
  /** 模型卡（由 ConfigModelsZone 组装传入——右栏「模型设置」，对齐 claude） */
  modelCard: ReactNode;
  /** v0.7.6 需求3：agent id（官方直连认证卡查询用）。 */
  agentId?: string;
  onChange: (patch: {
    modelProvider?: string | null;
    modelProviders?: Record<string, unknown> | null;
    env?: Record<string, string>;
    model?: string | null;
  }) => void;
}) {
  const { t } = useTranslation();
  // 查看目标渠道（右侧展示其接入配置）；null = 官方直连视图。初始跟随
  // 生效渠道（直连时 = null）。查看态与生效态分离：切换生效统一走右栏
  // 「启用此渠道」（v0.7.6 需求3 迭代三——修复直连态下点击渠道无反馈：
  // 此前直连态左栏 selectedId 被强制置空、右栏只认 modelProvider）。
  const [selectedId, setSelectedId] = useState<string | null>(modelProvider ?? null);
  // v0.9.0 需求14：直连视图实时模型清单。
  const directLiveModels = useCodexLiveModels(agentId, selectedId === null);
  // v0.7.6 需求3：custom 从清单一项改为「添加自定义渠道」按钮触发的表单态。
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");

  const providers = (modelProviders ?? {}) as Record<string, ProviderEntry>;
  const envMap = env ?? {};
  const showProxy = Boolean(modelProvider);

  /** 左栏渠道清单（统一侧栏数据）：预置渠道 + 已建的非预设自定义渠道。 */
  const channels: ChannelSidebarItem[] = [
    ...CODEX_PROXY_PRESETS.filter((p) => p.id !== "custom").map((p) => ({
      id: p.id,
      label: t(p.labelKey),
      sub: p.baseUrl,
      active: modelProvider === p.id,
    })),
    ...Object.entries(providers)
      .filter(([id]) => !CODEX_PROXY_PRESETS.some((p) => p.id === id))
      .map(([id, entry]) => ({
        id,
        label: entry.name || id,
        sub: entry.base_url || "",
        active: modelProvider === id,
      })),
  ];
  const selectedPreset = CODEX_PROXY_PRESETS.find((p) => p.id === selectedId);
  const selectedProvider = selectedId ? providers[selectedId] : undefined;
  const selectedLabel =
    channels.find((c) => c.id === selectedId)?.label ?? selectedId ?? "";

  /** 应用预设渠道：生成/覆盖渠道并激活；当前模型不在渠道候选内时
   *  带入预设默认模型（v0.7.6 需求2：切渠道模型对齐）；wire_api 按预设
   *  声明（v0.7.6 需求3：百炼/KIMI 为 chat）。 */
  const applyPreset = (presetId: string) => {
    setSelectedId(presetId);
    setCustomFormOpen(false);
    const preset = CODEX_PROXY_PRESETS.find((p) => p.id === presetId);
    if (!preset || preset.id === "custom") return;
    const keepModel = model && preset.models.includes(model);
    onChange({
      modelProvider: preset.id,
      modelProviders: {
        ...providers,
        [preset.id]: {
          name: t(preset.labelKey),
          base_url: preset.baseUrl,
          wire_api: preset.wireApi ?? "responses",
          env_key: preset.envKey,
        },
      },
      ...(keepModel ? {} : { model: preset.model || null }),
    });
  };

  // 左栏点击渠道 = 仅选中查看（v0.7.6 需求3 迭代三：切换生效统一走右栏
  // 「启用此渠道」按钮 applyPreset）。
  const handleChannelSelect = (id: string) => {
    setSelectedId(id);
    setCustomFormOpen(false);
  };

  const activeEnvKey = selectedProvider?.env_key ?? selectedPreset?.envKey ?? "API_KEY";
  const savedKey = envMap[activeEnvKey] ?? "";

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
      {/* 左：统一渠道侧栏（官方直连 + 预置 + 自定义 + 添加按钮）。
          直连项点击 = 查看直连并切回直连（清 modelProvider）；渠道项点击
          仅查看，生效走右栏「启用此渠道」。 */}
      <ChannelSidebar
        directLabel={t("config.connectDirect")}
        directActive={!showProxy}
        directSelected={!customFormOpen && selectedId === null}
        onSelectDirect={() => {
          setCustomFormOpen(false);
          setSelectedId(null);
          if (modelProvider) onChange({ modelProvider: null });
        }}
        channels={channels}
        selectedId={customFormOpen ? null : selectedId}
        onSelect={handleChannelSelect}
        onAddCustom={() => setCustomFormOpen(true)}
      />

      {/* 右：模型设置 + 渠道接入配置（按查看态渲染，非生效态） */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground">{t("config.colModels")}</div>
        {modelCard}

        {customFormOpen ? (
          /* 添加自定义渠道表单（v0.7.6 需求3：与预置渠道右栏同构 + 地址输入）。 */
          <div className="space-y-3 rounded-md border border-border/40 bg-muted/20 p-4">
            <div className="text-sm font-medium">{t("config.channelAddCustom")}</div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("config.codexCustomChannelHint")}
            </p>
            <CustomChannelForm
              providers={providers}
              onCreate={(id, entry, key, modelValue) => {
                setSelectedId(id);
                setCustomFormOpen(false);
                onChange({
                  modelProvider: id,
                  modelProviders: { ...providers, [id]: entry },
                  env: { ...envMap, [entry.env_key ?? `${id.toUpperCase()}_API_KEY`]: key },
                  ...(modelValue ? { model: modelValue } : {}),
                });
              }}
            />
          </div>
        ) : selectedId === null ? (
          /* 官方直连视图：提示 + 认证卡 + 模型列表（模型候选 =
             CODEX_DIRECT_MODELS + 直连态自定义记忆）。 */
          <div className="space-y-3">
            <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
              {t("config.codexDirectHint")}
            </div>
            {agentId && (
              <OfficialAuthCard agentId={agentId} hintKey="config.officialAuthHintCodex" />
            )}
            {/* v0.9.0 需求14：直连候选 = app-server model/list 实时拉取
                （静态预置表已删——其型号与账号可用集脱节，正是 400 问题源头）；
                拉取中/失败为空，自由输入仍可手填。 */}
            <CodexChannelModels
              providerId="direct"
              presetModels={directLiveModels}
              currentModel={model}
              onSelectModel={(m) => onChange({ model: m })}
            />
          </div>
        ) : selectedProvider || selectedPreset ? (
          <div className="space-y-3 rounded-md border border-border/40 bg-muted/20 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium">{selectedLabel}</div>
              {modelProvider === selectedId ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                  <Check className="h-3 w-3" />
                  {t("config.channelActive")}
                </span>
              ) : selectedPreset ? (
                <Button
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  onClick={() => applyPreset(selectedPreset.id)}
                >
                  <Power className="mr-1 h-3 w-3" />
                  {t("config.channelEnable")}
                </Button>
              ) : selectedProvider ? (
                /* 自定义渠道：直接切换激活（渠道条目已存在） */
                <Button
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  onClick={() => onChange({ modelProvider: selectedId })}
                >
                  <Power className="mr-1 h-3 w-3" />
                  {t("config.channelEnable")}
                </Button>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label>{t("config.baseUrl")}</Label>
              <code className="block truncate rounded bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">
                {selectedProvider?.base_url ?? selectedPreset?.baseUrl ?? ""}
              </code>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="codex-channel-apikey">{t("config.apiKey")}</Label>
                {selectedPreset?.apiKeyUrl && (
                  <button
                    type="button"
                    onClick={() =>
                      void invokeCommand("open_url", { url: selectedPreset.apiKeyUrl })
                    }
                    className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                  >
                    {t("config.presetGetKey")}
                    <ExternalLink className="h-3 w-3" />
                  </button>
                )}
              </div>
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
              {selectedProvider?.wire_api === "chat"
                ? t("config.proxyChatHint")
                : t("config.proxyResponsesHint")}
            </p>
          </div>
        ) : null}

        {/* 渠道模型列表（v0.7.6 需求3 迭代六：代理渠道也支持显式添加
            模型，对齐 jishu 交互；自定义渠道 presetModels 为空纯手加）。 */}
        {selectedId !== null && !customFormOpen && (
          <CodexChannelModels
            providerId={selectedId}
            presetModels={selectedPreset?.models ?? []}
            currentModel={model}
            onSelectModel={(m) => onChange({ model: m })}
          />
        )}
      </div>
    </div>
  );
}

/** 渠道模型列表（v0.7.6 需求3 迭代六：对齐 jishu 交互——右栏下方展示
 *  渠道模型，支持添加自定义模型与设为当前）。预置模型不可删；自定义
 *  模型存 localStorage 按渠道记忆（codex config.toml 无模型列表原生键，
 *  不发明私有键污染配置）。 */
function CodexChannelModels({
  providerId,
  presetModels,
  currentModel,
  onSelectModel,
}: {
  /** 渠道 id；直连态传 "direct" */
  providerId: string;
  presetModels: string[];
  currentModel: string | null | undefined;
  onSelectModel: (model: string) => void;
}) {
  const { t } = useTranslation();
  // localStorage 非响应式：tick 强制添加/删除后重读（也顺带同步模型卡
  // 下拉自由输入写入的记忆）。
  const [tick, setTick] = useState(0);
  const [input, setInput] = useState("");
  const custom = codexCustomModelsFor(providerId);
  const all = [...presetModels, ...custom.filter((m) => !presetModels.includes(m))];

  const add = () => {
    const id = input.trim();
    if (!id || all.includes(id)) return;
    rememberCodexCustomModel(providerId, id);
    setInput("");
    setTick((v) => v + 1);
    onSelectModel(id);
  };
  void tick;

  return (
    <div className="space-y-1.5 rounded-md border border-border/40 bg-muted/20 p-4">
      <Label className="text-[10px] text-muted-foreground/80">
        {t("config.models")} ({all.length})
      </Label>
      {all.length === 0 ? (
        <p className="px-1 text-[10px] text-muted-foreground/70">{t("config.noModelsHint")}</p>
      ) : (
        <ul className="space-y-1">
          {all.map((mid) => {
            const isCurrent = currentModel === mid;
            const isCustom = custom.includes(mid) && !presetModels.includes(mid);
            return (
              <li
                key={mid}
                className={
                  "flex items-center gap-2 rounded border px-2 py-1.5 " +
                  (isCurrent ? "border-primary/60 bg-primary/10" : "border-border/30")
                }
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{mid}</span>
                <Button
                  size="sm"
                  variant={isCurrent ? "default" : "outline"}
                  className="h-6 text-xs"
                  onClick={() => onSelectModel(mid)}
                  title={t("config.setActive")}
                >
                  {isCurrent ? <Check className="h-3 w-3" /> : <Power className="h-3 w-3" />}
                </Button>
                {isCustom && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-red-400 hover:text-red-300"
                    onClick={() => {
                      removeCodexCustomModel(providerId, mid);
                      setTick((v) => v + 1);
                    }}
                    title={t("common.delete")}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("config.modelIdPlaceholder")}
          className="h-8 flex-1 font-mono text-xs"
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!input.trim()} onClick={add}>
          <Plus className="mr-1 h-3 w-3" />
          {t("config.addModel")}
        </Button>
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground/70">
        {t("config.codexCustomModelHint")}
      </p>
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
