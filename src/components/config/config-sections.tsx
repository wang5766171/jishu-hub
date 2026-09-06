// v0.7.4 需求2 R4/R6：structured 配置（claude/codex/opencode）的三个子页内容区。
// 草稿状态提升到 structured.tsx（子页切换不丢未保存修改），本文件是纯
// 展示组件：接收 config + onChange(partial)，按 surface 能力组合渲染。
//  - ConfigModelsZone：R6 两栏结构——左「渠道设置」右「模型设置」；claude
//    支持「配置代理 / 官方直连」切换（直连无渠道配置），codex/opencode 仅模型
//  - ConfigBehaviorZone：权限模式卡 + 允许/拒绝规则 + 沙箱/跳过危险确认
//  - ConfigAdvancedZone：env / 插件 / MCP / 模型细节 / 杂项

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ArrowRight, Check, Eye, EyeOff, ExternalLink, Plus, Power, Trash2 } from "lucide-react";
import type { AgentConfigSection, ClaudeConfig } from "@/types";
import { ModelCombobox } from "./model-combobox";
import { PermissionModeCards } from "./permission-cards";
import { RuleQuickAdd } from "./rule-quick-add";
import { ActiveModelCard, type ActiveModelOption } from "./active-model-card";
import { AdvancedBlock } from "./config-page-shell";
import { ChannelSidebar, type ChannelSidebarItem } from "./channel-sidebar";
import { OfficialAuthCard } from "./official-auth-card";
import { CLAUDE_MODEL_CATALOG } from "@/agents/config/presets/claude-models";
import { OPENCODE_MODEL_CATALOG } from "@/agents/config/presets/opencode-models";
import { OpencodeProvidersBlock } from "./opencode-providers";
import { CodexProvidersBlock } from "./codex-providers";
import {
  CODEX_PROXY_PRESETS,
  codexCustomModelsFor,
  rememberCodexCustomModel,
} from "@/agents/config/presets/codex-presets";
import { useCodexLiveModels } from "@/hooks/use-codex-live-models";
import {
  CLAUDE_PROXY_PRESETS,
  applyProxyPresetToEnv,
  removeProxyEnv,
  type ClaudeProxyPreset,
} from "@/agents/config/presets/claude-presets";

/** 模型推荐目录注册表：adapter 经 surface.model_catalog 声明使用哪份（§5）。 */
const MODEL_CATALOGS: Record<string, { value: string; labelKey: string }[]> = {
  claude: CLAUDE_MODEL_CATALOG,
  opencode: OPENCODE_MODEL_CATALOG,
};

/** 自定义供应商（opencode provider 段）的模型拍平为 provider/model 候选，
 *  置顶于静态目录之前——用户新加的模型立即可选（R12 迭代三）。 */
function customProviderModelOptions(
  config: ClaudeConfig,
): ActiveModelOption[] {
  const asObj = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
  return Object.entries(config.customProviders ?? {}).flatMap(([pid, p]) => {
    const providerObj = asObj(p);
    return Object.entries(asObj(providerObj.models)).map(([mid, m]) => ({
      value: `${pid}/${mid}`,
      label: asStr(asObj(m).name) || mid,
      hint: asStr(providerObj.name) || pid,
    }));
  });
}

/** 按声明目录取候选项（未声明 = 空目录，仅自由输入）。 */
function modelCatalogOptionsFor(
  surface: ConfigSurfaceFlags | undefined,
  t: (key: string) => string,
): ActiveModelOption[] {
  const catalog = surface?.model_catalog ? MODEL_CATALOGS[surface.model_catalog] : undefined;
  if (!catalog) return [];
  return catalog.map((m) => ({ value: m.value, label: t(m.labelKey) }));
}

/** codex 渠道的预置模型（v0.7.6 需求2：直连 = OpenAI 官方预置，代理 =
 *  所选渠道预设 models，未知自定义渠道 = 空即纯自由输入），并追加该渠道
 *  记忆的自定义模型（localStorage，防后续上新模型重复手输）。 */
function codexPresetModelsFor(providerId: string): string[] {
  const presetModels = CODEX_PROXY_PRESETS.find((p) => p.id === providerId)?.models ?? [];
  const custom = codexCustomModelsFor(providerId);
  return [...presetModels, ...custom.filter((m) => !presetModels.includes(m))];
}

/** claude 模型链路环境变量的展示序（v0.7.6 需求2：模型子页透出实际生效值）。 */
const MODEL_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "MAX_THINKING_TOKENS",
] as const;

/** 密钥类 env 值脱敏（键名含 TOKEN/KEY）。 */
function maskEnvValue(key: string, value: string): string {
  if (!/TOKEN|KEY/.test(key)) return value;
  return value.length > 8 ? `••••${value.slice(-4)}` : "••••";
}

/** 「当前生效环境变量」只读块：展示模型链路 env 实际值，跳转高级设置修改。 */
function ModelEnvOverview({
  env,
  onNavigate,
}: {
  env: Record<string, string>;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const entries = MODEL_ENV_KEYS.map((key) => [key, env[key]] as const).filter(
    ([, v]) => v !== undefined && v.trim() !== "",
  );

  return (
    <div className="space-y-2 rounded-md border border-border/40 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">{t("config.modelEnvTitle")}</div>
        {onNavigate && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 text-xs"
            onClick={onNavigate}
          >
            {t("config.modelEnvEdit")}
            <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
          {t("config.modelEnvEmpty")}
        </p>
      ) : (
        <div className="space-y-1">
          {entries.map(([key, value]) => (
            <div key={key} className="flex items-center gap-2 text-[11px]">
              <code className="shrink-0 font-mono text-muted-foreground">{key}</code>
              <span className="min-w-0 flex-1 truncate font-mono" title={value}>
                {maskEnvValue(key, value)}
              </span>
            </div>
          ))}
        </div>
      )}
      {onNavigate && <p className="text-[10px] text-muted-foreground/70">{t("config.modelEnvHint")}</p>}
    </div>
  );
}

const API_PROVIDERS = [
  { value: "anthropic", labelKey: "providerAnthropic" },
  { value: "bedrock", labelKey: "providerBedrock" },
  { value: "vertex", labelKey: "providerVertex" },
];

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export interface ConfigZoneProps {
  config: ClaudeConfig;
  onChange: (partial: Partial<ClaudeConfig>) => void;
}

export interface ConfigSurfaceFlags {
  supports_model_picker: boolean;
  supports_small_model: boolean;
  supports_large_model: boolean;
  supports_api_provider: boolean;
  supports_proxy_setup?: boolean;
  supports_config_test?: boolean;
  supports_reasoning_effort?: boolean;
  supports_thinking_budget?: boolean;
  model_catalog?: string | null;
  supports_custom_providers?: boolean;
  /** v0.7.5 需求7：codex model_providers 渠道管理。 */
  supports_model_providers?: boolean;
}

/** 「模型设置」子页（R6 两栏结构，参考用户截图）。
 *  claude（supports_proxy_setup）：顶部「配置代理 / 官方直连」切换——
 *  代理 = 左渠道列表 + 右模型卡与渠道密钥；直连 = 无渠道配置仅模型。
 *  codex/opencode：无代理能力，仅当前模型大卡（自由输入）。 */
export function ConfigModelsZone({
  config,
  onChange,
  surface,
  onNavigateSection,
  agentId,
}: ConfigZoneProps & {
  surface?: ConfigSurfaceFlags;
  /** v0.7.6 需求2：跳转到指定配置子页（env 块「前往高级设置修改」）。 */
  onNavigateSection?: (section: AgentConfigSection) => void;
  /** v0.7.6 需求3：管理作用域 agent id（官方直连认证卡查询用）。 */
  agentId?: string;
}) {
  const { t } = useTranslation();
  const supportsProxySetup = surface?.supports_proxy_setup ?? false;

  const env = config.env ?? {};
  const proxyBaseUrl = env["ANTHROPIC_BASE_URL"]?.trim() || "";
  const activePreset: ClaudeProxyPreset | undefined = CLAUDE_PROXY_PRESETS.find(
    (p) => !p.custom && p.baseUrl === proxyBaseUrl,
  );
  const isDirect = !proxyBaseUrl;

  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  // codex 渠道态（supports_model_providers 分支）：当前激活渠道 id。
  const isCodexProviders = !supportsProxySetup && Boolean(surface?.supports_model_providers);
  const codexProviderId = isCodexProviders
    ? ((config as { modelProvider?: string | null }).modelProvider ?? null)
    : null;
  // v0.9.0 需求14：codex 直连候选 = app-server model/list 实时拉取
  //（静态预置表已按用户裁决删除）+ 直连态自定义记忆。
  const codexDirectModels = useCodexLiveModels(agentId, isCodexProviders && !codexProviderId);
  const codexDirectCatalog = [
    ...codexDirectModels,
    ...codexCustomModelsFor("direct").filter((m) => !codexDirectModels.includes(m)),
  ];

  // 候选项按接入态分流（v0.7.6 需求2）：
  //  - codex：直连 = OpenAI 官方预置，代理 = 渠道预设 models + 自定义记忆；
  //  - claude 代理态：命中预设 = 渠道 models（不再混入官方目录），自定义
  //    地址 = 空（纯自由输入）；
  //  - claude 直连态 / opencode：自定义供应商模型 + adapter 声明目录（原状）。
  const seen = new Set<string>();
  const catalogOptions: ActiveModelOption[] = (
    isCodexProviders
      ? (codexProviderId
          ? codexPresetModelsFor(codexProviderId)
          : codexDirectCatalog
        ).map((m) => ({ value: m, label: m }))
      : supportsProxySetup && !isDirect
        ? (activePreset?.models ?? []).map((m) => ({ value: m, label: m }))
        : [
            ...customProviderModelOptions(config),
            ...modelCatalogOptionsFor(surface, t),
          ]
  ).filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true)));
  const currentModelOption: ActiveModelOption | null = config.model
    ? {
        value: config.model,
        label: catalogOptions.find((o) => o.value === config.model)?.label ?? config.model,
      }
    : null;

  const handleModelSelect = (model: string) => {
    onChange({ model: model || null });
    // codex：自由输入的模型不在渠道预置内时记入候选（localStorage 按渠道隔离，
    // 防后续上新模型重复手输）。
    if (
      isCodexProviders &&
      model &&
      !catalogOptions.some((o) => o.value === model)
    ) {
      rememberCodexCustomModel(codexProviderId ?? "direct", model);
    }
  };

  const modelCard = (
    <ActiveModelCard
      current={currentModelOption}
      options={catalogOptions}
      onSelect={handleModelSelect}
      allowCustom
      customPlaceholder={t("config.modelComboboxPlaceholder")}
      // 模型卡空态提示按 agent 语义区分（迭代四：codex 不再显示 claude 的
      // 订阅/Anthropic 文案）。claude 保持原键。
      emptyHint={
        surface?.supports_model_providers
          ? t("config.codexDirectHint")
          : t("config.connectDirectHint")
      }
    />
  );

  const applyChannel = (preset: ClaudeProxyPreset) => {
    setSelectedChannelId(preset.id);
    if (preset.custom) return;
    // 切渠道模型联动：当前模型不在目标渠道候选内时回落渠道默认，
    // 避免残留旧渠道/官方模型（v0.7.6 需求2）。
    const keepModel = config.model && preset.models.includes(config.model);
    onChange({
      env: applyProxyPresetToEnv(preset, "", env),
      model: keepModel ? config.model : preset.model || null,
    });
  };

  const savedToken = env["ANTHROPIC_AUTH_TOKEN"]?.trim() || env["ANTHROPIC_API_KEY"]?.trim() || "";

  // 无代理能力的 structured agent：opencode = 模型卡 + 自定义供应商管理块；
  // codex = CodexProvidersBlock（自带直连态/代理双栏布局，模型卡由其承载——
  // 迭代五：布局完全对齐 claude 的左右双栏结构）。
  if (!supportsProxySetup) {
    if (surface?.supports_model_providers) {
      return (
        <CodexProvidersBlock
          model={config.model ?? null}
          modelProvider={(config as { modelProvider?: string | null }).modelProvider ?? null}
          modelProviders={
            (config as unknown as { modelProviders?: Record<string, unknown> }).modelProviders ?? null
          }
          env={(config.env ?? {}) as Record<string, string>}
          modelCard={modelCard}
          agentId={agentId}
          onChange={(patch) => onChange(patch as Partial<ClaudeConfig>)}
        />
      );
    }
    // opencode：统一渠道布局（内置渠道预置 + 自定义渠道 + 启用按钮），
    // modelCard 由组件内右栏承载。
    if (surface?.supports_custom_providers) {
      return (
        <OpencodeProvidersBlock
          providers={config.customProviders ?? {}}
          model={config.model ?? null}
          modelCard={modelCard}
          onChange={(patch) => onChange(patch as Partial<ClaudeConfig>)}
        />
      );
    }
    return <div className="space-y-4">{modelCard}</div>;
  }

  // v0.7.6 需求3：统一两栏布局——左 ChannelSidebar（官方直连 + 预置渠道 +
  // 自定义渠道 + 底部添加按钮），右模型卡 + 渠道配置。顶部切换按钮移除，
  // 直连/代理由左栏选择驱动（选直连 = 清除代理 env；选渠道 = 写入 env）。
  const CUSTOM_CHANNEL_ID = "__custom";
  const proxyPresets = CLAUDE_PROXY_PRESETS.filter((p) => !p.custom);
  const customActive = !isDirect && !activePreset;
  // 有效选中渠道：null = 跟随生效态推导（直连 / 激活预设 / 生效自定义地址）。
  const effectiveChannelId =
    selectedChannelId ??
    (isDirect ? "direct" : activePreset ? activePreset.id : CUSTOM_CHANNEL_ID);

  const sidebarChannels: ChannelSidebarItem[] = [
    ...proxyPresets.map((p): ChannelSidebarItem => ({
      id: p.id,
      label: t(p.labelKey),
      sub: p.baseUrl,
      active: activePreset?.id === p.id,
    })),
    ...(customActive
      ? [{
          id: CUSTOM_CHANNEL_ID,
          label: t("config.preset.custom.name"),
          sub: proxyBaseUrl,
          active: true,
        } satisfies ChannelSidebarItem]
      : []),
  ];

  // 左栏点击渠道 = 仅选中查看（v0.7.6 需求3 迭代三：切换生效统一走右栏
  // 「启用此渠道」按钮——预置渠道 applyChannel / 自定义表单「保存并启用」）。
  const handleChannelSelect = (id: string) => {
    setSelectedChannelId(id);
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
      {/* 左：统一渠道侧栏 */}
      <ChannelSidebar
        directLabel={t("config.connectDirect")}
        directActive={isDirect}
        directSelected={effectiveChannelId === "direct"}
        onSelectDirect={() => {
          setSelectedChannelId("direct");
          if (!isDirect) onChange({ env: removeProxyEnv(env) });
        }}
        channels={sidebarChannels}
        selectedId={effectiveChannelId === "direct" ? null : effectiveChannelId}
        onSelect={handleChannelSelect}
        onAddCustom={() => setSelectedChannelId(CUSTOM_CHANNEL_ID)}
      />

      {/* 右：模型设置 + 渠道接入配置 */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground">{t("config.colModels")}</div>
        {modelCard}

        {effectiveChannelId === "direct" ? (
          /* 官方直连：提示 + 认证卡 + env 总览（模型候选 = 官方目录） */
          <div className="space-y-3">
            <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
              {t("config.connectDirectHint")}
            </div>
            {agentId && (
              <OfficialAuthCard
                agentId={agentId}
                hintKey="config.officialAuthHintClaude"
              />
            )}
          </div>
        ) : effectiveChannelId === CUSTOM_CHANNEL_ID ? (
          /* 自定义渠道：地址 + 密钥 + 模型（v0.7.6 需求3：与预置渠道右栏同构，
             多地址输入；保存写 env 三键并启用）。 */
          <ClaudeCustomChannelCard
            key={customActive ? proxyBaseUrl : "new"}
            baseUrl={customActive ? proxyBaseUrl : ""}
            model={env["ANTHROPIC_MODEL"] ?? ""}
            onApply={(baseUrl, token, model) => {
              const next = { ...env };
              next["ANTHROPIC_BASE_URL"] = baseUrl;
              if (token.trim()) next["ANTHROPIC_AUTH_TOKEN"] = token.trim();
              if (model.trim()) next["ANTHROPIC_MODEL"] = model.trim();
              onChange({ env: next, model: model.trim() || config.model || null });
            }}
          />
        ) : (
          /* 预置渠道接入配置 */
          (() => {
            const selected = proxyPresets.find((p) => p.id === effectiveChannelId);
            if (!selected) return null;
            return (
              <div className="space-y-3 rounded-md border border-border/40 bg-muted/20 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">{t(selected.labelKey)}</div>
                  {activePreset?.id === selected.id ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                      <Check className="h-3 w-3" />
                      {t("config.channelActive")}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      className="h-7 shrink-0 text-xs"
                      onClick={() => applyChannel(selected)}
                    >
                      <Power className="mr-1 h-3 w-3" />
                      {t("config.channelEnable")}
                    </Button>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label>{t("config.baseUrl")}</Label>
                  <code className="block truncate rounded bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">
                    {selected.baseUrl}
                  </code>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="channel-apikey">{t("config.apiKey")}</Label>
                    {selected.apiKeyUrl && (
                      <button
                        type="button"
                        onClick={() => void invokeCommand("open_url", { url: selected.apiKeyUrl })}
                        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                      >
                        {t("config.presetGetKey")}
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      id="channel-apikey"
                      type={showKey ? "text" : "password"}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
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
                      disabled={!apiKey.trim()}
                      onClick={() =>
                        onChange({ env: applyProxyPresetToEnv(selected, apiKey, env) })
                      }
                    >
                      {t("config.quickSetupApplyKey")}
                    </Button>
                  </div>
                  {savedToken && (
                    <p className="text-[10px] text-muted-foreground/70">
                      {t("config.channelKeySaved")}
                      {savedToken.length > 8
                        ? `：••••${savedToken.slice(-4)}`
                        : ""}
                    </p>
                  )}
                </div>
                <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                  {t("config.channelSaveHint")}
                </p>
              </div>
            );
          })()
        )}

        {/* v0.7.6 需求2：透出当前生效的模型链路环境变量，可跳转高级设置修改 */}
        <ModelEnvOverview
          env={env}
          onNavigate={onNavigateSection ? () => onNavigateSection("advanced") : undefined}
        />
      </div>
    </div>
  );
}

/** claude 自定义渠道卡：地址 + 密钥 + 模型（Anthropic 兼容端点），
 *  保存写 env 三键并启用（v0.7.6 需求3）。 */
function ClaudeCustomChannelCard({
  baseUrl,
  model,
  onApply,
}: {
  baseUrl: string;
  model: string;
  onApply: (baseUrl: string, token: string, model: string) => void;
}) {
  const { t } = useTranslation();
  const [addr, setAddr] = useState(baseUrl);
  const [modelId, setModelId] = useState(model);
  const [token, setToken] = useState("");
  const [showKey, setShowKey] = useState(false);
  const valid = addr.trim().startsWith("http");

  return (
    <div className="space-y-3 rounded-md border border-border/40 bg-muted/20 p-4">
      <div className="text-sm font-medium">{t("config.preset.custom.name")}</div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("config.channelCustomHint")}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="custom-baseurl">Base URL</Label>
        <Input
          id="custom-baseurl"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="https://example.com/anthropic"
          className="font-mono text-xs"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="custom-model">{t("config.modelId")}</Label>
        <Input
          id="custom-model"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder={t("config.modelIdPlaceholder")}
          className="font-mono text-xs"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="custom-apikey">{t("config.apiKey")}</Label>
        <div className="flex gap-2">
          <Input
            id="custom-apikey"
            type={showKey ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
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
            disabled={!valid}
            onClick={() => onApply(addr.trim(), token, modelId)}
          >
            {t("config.customChannelApply")}
          </Button>
        </div>
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground/70">
        {t("config.channelSaveHint")}
      </p>
    </div>
  );
}

/** 「行为与权限」子页：权限模式 + 允许/拒绝规则 + 沙箱/危险确认开关。 */
export function ConfigBehaviorZone({ config, onChange }: ConfigZoneProps) {
  const { t } = useTranslation();
  const [newAllowPattern, setNewAllowPattern] = useState("");
  const [newDenyPattern, setNewDenyPattern] = useState("");

  const updatePermissions = (partial: Partial<ClaudeConfig["permissions"]>) => {
    onChange({
      permissions: { ...(config.permissions || {}), ...partial } as ClaudeConfig["permissions"],
    });
  };

  const handleAddAllowPattern = () => {
    if (!newAllowPattern.trim()) return;
    updatePermissions({ allow: [...(config.permissions?.allow ?? []), newAllowPattern.trim()] });
    setNewAllowPattern("");
  };

  const handleAddDenyPattern = () => {
    if (!newDenyPattern.trim()) return;
    updatePermissions({ deny: [...(config.permissions?.deny ?? []), newDenyPattern.trim()] });
    setNewDenyPattern("");
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="permMode">{t("config.permissionMode")}</Label>
        <PermissionModeCards
          value={config.permissions?.defaultMode || ""}
          onChange={(val) => updatePermissions({ defaultMode: val || null })}
        />
      </div>

      <div className="space-y-2">
        <Label>{t("config.allowList")}</Label>
        <RuleQuickAdd
          patterns={config.permissions?.allow ?? []}
          onAdd={(pattern) => {
            updatePermissions({ allow: [...(config.permissions?.allow ?? []), pattern] });
          }}
        />
        <div className="space-y-2">
          {(config.permissions?.allow ?? []).map((pattern, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono">{pattern}</code>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => {
                  const allow = [...(config.permissions?.allow ?? [])];
                  allow.splice(idx, 1);
                  updatePermissions({ allow: allow.length > 0 ? allow : null });
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Input
              value={newAllowPattern}
              onChange={(e) => setNewAllowPattern(e.target.value)}
              placeholder={t("config.patternPlaceholder")}
              className="flex-1"
              onKeyDown={(e) => e.key === "Enter" && handleAddAllowPattern()}
            />
            <Button variant="outline" size="sm" onClick={handleAddAllowPattern} disabled={!newAllowPattern.trim()}>
              <Plus className="mr-1 h-3 w-3" />
              {t("config.addPattern")}
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t("config.denyList")}</Label>
        <RuleQuickAdd
          patterns={config.permissions?.deny ?? []}
          onAdd={(pattern) => {
            updatePermissions({ deny: [...(config.permissions?.deny ?? []), pattern] });
          }}
        />
        <div className="space-y-2">
          {(config.permissions?.deny ?? []).map((pattern, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono">{pattern}</code>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => {
                  const deny = [...(config.permissions?.deny ?? [])];
                  deny.splice(idx, 1);
                  updatePermissions({ deny: deny.length > 0 ? deny : null });
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Input
              value={newDenyPattern}
              onChange={(e) => setNewDenyPattern(e.target.value)}
              placeholder={t("config.patternPlaceholder")}
              className="flex-1"
              onKeyDown={(e) => e.key === "Enter" && handleAddDenyPattern()}
            />
            <Button variant="outline" size="sm" onClick={handleAddDenyPattern} disabled={!newDenyPattern.trim()}>
              <Plus className="mr-1 h-3 w-3" />
              {t("config.addPattern")}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md border px-3 py-3">
        <div className="space-y-0.5">
          <Label>{t("config.sandbox")}</Label>
          <p className="text-xs text-muted-foreground">
            {config.sandbox?.enabled ? t("config.enabled") : t("config.disabled")}
          </p>
        </div>
        <Switch
          checked={config.sandbox?.enabled === true}
          onCheckedChange={(checked) =>
            onChange({
              sandbox: { ...(config.sandbox || {}), enabled: checked } as ClaudeConfig["sandbox"],
            })
          }
        />
      </div>

      <div className="flex items-center justify-between rounded-md border px-3 py-3">
        <div className="space-y-0.5">
          <Label>{t("config.skipDangerous")}</Label>
          <p className="text-xs text-muted-foreground">{t("config.skipDangerousDesc")}</p>
        </div>
        <Switch
          checked={config.skipDangerousModePermissionPrompt === true}
          onCheckedChange={(checked) =>
            onChange({ skipDangerousModePermissionPrompt: checked || null })
          }
        />
      </div>
    </div>
  );
}

/** 「高级设置」子页：advancedExtra（备份/导出导入等）+ env / 插件 / MCP / 模型细节 / 杂项。 */
export function ConfigAdvancedZone({
  config,
  onChange,
  surface,
  advancedExtra,
}: ConfigZoneProps & { surface?: ConfigSurfaceFlags; advancedExtra?: ReactNode }) {
  const { t } = useTranslation();
  const supportsSmallModel = surface?.supports_small_model ?? true;
  const supportsLargeModel = surface?.supports_large_model ?? true;
  const supportsApiProvider = surface?.supports_api_provider ?? true;
  const showAdvancedModels = supportsSmallModel || supportsLargeModel || supportsApiProvider;
  const [newEnvKey, setNewEnvKey] = useState("");

  // small/large 候选与当前模型大卡同源（自定义供应商模型 + 声明目录）。
  const modelCatalogOptions: ActiveModelOption[] = [
    ...customProviderModelOptions(config),
    ...modelCatalogOptionsFor(surface, t),
  ];

  const handleEnvChange = (key: string, value: string) => {
    const env = { ...(config.env || {}) };
    env[key] = value;
    onChange({ env });
  };

  const handleEnvDelete = (key: string) => {
    const env = { ...(config.env || {}) };
    delete env[key];
    onChange({ env });
  };

  const handleAddEnv = () => {
    if (!newEnvKey.trim()) return;
    const env = { ...(config.env || {}) };
    env[newEnvKey.trim()] = "";
    onChange({ env });
    setNewEnvKey("");
  };

  return (
    <div className="space-y-4">
      {advancedExtra}

      <AdvancedBlock title={t("config.envVars")} help={t("config.fieldMapEnv")}>
        {/* 需求4 B1：claude 思考预算快捷入口（env.MAX_THINKING_TOKENS）。 */}
        {surface?.supports_thinking_budget && !(config.env ?? {})["MAX_THINKING_TOKENS"] && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-dashed border-border/50 px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium">{t("config.thinkingBudgetTitle")}</p>
              <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                {t("config.thinkingBudgetHint")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 text-xs"
              onClick={() => handleEnvChange("MAX_THINKING_TOKENS", "31999")}
            >
              <Plus className="mr-1 h-3 w-3" />
              {t("config.thinkingBudgetAdd")}
            </Button>
          </div>
        )}
        <div className="space-y-2 pt-1">
          {Object.entries(config.env || {}).map(([key, value]) => (
            <div key={key} className="flex items-center gap-2">
              <code className="min-w-[140px] rounded bg-muted px-2 py-1 text-xs font-mono">{key}</code>
              <Input
                value={value}
                onChange={(e) => handleEnvChange(key, e.target.value)}
                className="flex-1"
                placeholder={t("config.value")}
              />
              <Button variant="ghost" size="icon-xs" onClick={() => handleEnvDelete(key)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Input
              value={newEnvKey}
              onChange={(e) => setNewEnvKey(e.target.value)}
              className="min-w-[140px]"
              placeholder={t("config.key")}
              onKeyDown={(e) => e.key === "Enter" && handleAddEnv()}
            />
            <Button variant="outline" size="sm" onClick={handleAddEnv} disabled={!newEnvKey.trim()}>
              <Plus className="mr-1 h-3 w-3" />
              {t("common.add")}
            </Button>
          </div>
        </div>
      </AdvancedBlock>

      <AdvancedBlock title={t("config.enabledPlugins")} help={t("config.fieldMapPlugins")}>
        <div className="space-y-2 pt-1">
          {Object.entries(config.enabledPlugins || {}).map(([plugin, enabled]) => (
            <div key={plugin} className="flex items-center justify-between rounded-md border px-3 py-2">
              <code className="text-xs font-mono">{plugin}</code>
              <div className="flex items-center gap-2">
                <Switch
                  checked={enabled}
                  onCheckedChange={(checked) => {
                    const plugins = { ...(config.enabledPlugins || {}) };
                    plugins[plugin] = checked;
                    onChange({ enabledPlugins: plugins });
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    const plugins = { ...(config.enabledPlugins || {}) };
                    delete plugins[plugin];
                    onChange({ enabledPlugins: plugins });
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
          {(!config.enabledPlugins || Object.keys(config.enabledPlugins).length === 0) && (
            <p className="text-sm text-muted-foreground">{t("config.noPlugins")}</p>
          )}
        </div>
      </AdvancedBlock>

      {/* 需求4 B1：推理力度（codex 的 model_reasoning_effort；静态配置，
          新会话生效——与 jishu 会话页运行时档位不同类，故只在配置页出现）。 */}
      {surface?.supports_reasoning_effort && (
        <AdvancedBlock title={t("config.reasoningEffortLabel")}>
          <div className="space-y-1.5 pt-1">
            <select
              value={config.reasoningEffort ?? ""}
              onChange={(e) =>
                onChange({ reasoningEffort: e.target.value || null })
              }
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:max-w-[240px]"
            >
              <option value="">{t("common.default")}</option>
              {["minimal", "low", "medium", "high", "xhigh"].map((effort) => (
                <option key={effort} value={effort}>
                  {t(`config.reasoningEffort.${effort}`)}
                </option>
              ))}
            </select>
            <p className="text-[10px] leading-relaxed text-muted-foreground/70">
              {t("config.reasoningEffortHint")}
            </p>
          </div>
        </AdvancedBlock>
      )}

      {showAdvancedModels && (
        <AdvancedBlock title={t("config.modelSettings")} help={t("config.fieldMapModel")}>
          <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-3">
            {supportsSmallModel && (
              <div className="space-y-2">
                <Label htmlFor="smallModel">{t("config.smallModel")}</Label>
                <ModelCombobox
                  id="smallModel"
                  value={config.smallModel || ""}
                  onChange={(val) => onChange({ smallModel: val || null })}
                  options={modelCatalogOptions}
                  placeholder={t("config.modelComboboxOptional")}
                />
              </div>
            )}
            {supportsLargeModel && (
              <div className="space-y-2">
                <Label htmlFor="largeModel">{t("config.largeModel")}</Label>
                <ModelCombobox
                  id="largeModel"
                  value={config.largeModel || ""}
                  onChange={(val) => onChange({ largeModel: val || null })}
                  options={modelCatalogOptions}
                  placeholder={t("config.modelComboboxOptional")}
                />
              </div>
            )}
            {supportsApiProvider && (
              <div className="space-y-2">
                <Label htmlFor="apiProvider">{t("config.apiProvider")}</Label>
                <select
                  id="apiProvider"
                  value={config.apiProvider || ""}
                  onChange={(e) => onChange({ apiProvider: e.target.value || null })}
                  className={selectClass}
                >
                  <option value="">{t("common.default")}</option>
                  {API_PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {t(`config.${p.labelKey}`)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </AdvancedBlock>
      )}

      <AdvancedBlock title={t("config.advanced")} help={t("config.fieldMapAdvanced")}>
        <div className="space-y-4 pt-1">
          <div className="flex items-center justify-between rounded-md border px-3 py-3">
            <Label>{t("config.verbose")}</Label>
            <Switch
              checked={config.verbose === true}
              onCheckedChange={(checked) => onChange({ verbose: checked || null })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="maxTurns">{t("config.maxTurns")}</Label>
            <Input
              id="maxTurns"
              type="number"
              min={1}
              value={config.maxTurns ?? ""}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                onChange({ maxTurns: isNaN(n) || n <= 0 ? null : n });
              }}
              placeholder="e.g., 200"
            />
          </div>
        </div>
      </AdvancedBlock>
    </div>
  );
}
