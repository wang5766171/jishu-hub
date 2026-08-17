// v0.7.4 需求2 R1：模型服务商预设注册表（jishu model_store 配置页数据源）。
//
// 原则（02 §0）：预设是纯数据——被填充的仍是 models.json 既有字段，
// 读写仍走 get/set_models_config IPC，后端契约零变化。全部预填值
// 均可在表单中修改（预填 ≠ 锁定）；「自定义」预设退化为全手填。
//
// baseUrl / apiKeyUrl 于 2026-08-15 按官方文档核对：
// - 智谱:   https://docs.bigmodel.cn/cn/guide/develop/claude/introduction
// - DeepSeek: https://api-docs.deepseek.com (anthropic 兼容端点)
// - Kimi:   https://platform.moonshot.cn/docs (anthropic 兼容端点)
// - Anthropic / OpenAI 官方文档

export interface ProviderModelPreset {
  /** 写入 models.json 的模型 id（可编辑） */
  id: string;
  /** 界面展示名 */
  displayName: string;
  /** 预填上下文窗口（token，可编辑） */
  contextWindow?: number;
  /** 预填最大输出（token，可编辑） */
  maxTokens?: number;
  /** 预填推理能力标记 */
  reasoning?: boolean;
  /** 档位映射声明（透传 Pi thinkingLevelMap）：值为 null 表示该档位
   * 不被模型支持——Pi 会把它从可用档位剔除并在请求时收敛到最近档位，
   * 同时不再向 API 发送对应的 thinking 参数。 */
  thinkingLevelMap?: Record<string, string | null>;
  /** 透传 Pi 模型 compat（如 forceAdaptiveThinking：智谱端点仅
   * adaptive+effort 档位真实生效，budget/disabled 均被忽略——2026-08-16
   * 端点实测）。 */
  compat?: Record<string, unknown>;
}

export interface ProviderPreset {
  /** 预设标识；"custom" 为兜底手填入口 */
  id: string;
  /** 展示名（i18n key：config.preset.<id>.name） */
  id_label: string;
  /** 接口地址（写入 provider.baseUrl） */
  baseUrl: string;
  /** 协议枚举（写入 provider.api） */
  api: string;
  /** 「获取密钥」官方外链 */
  apiKeyUrl?: string;
  /** 「查看文档」外链 */
  docsUrl?: string;
  /** 推荐模型（chips 预填，可勾选/取消） */
  models: ProviderModelPreset[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "zhipu",
    id_label: "config.preset.zhipu.name",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    api: "anthropic-messages",
    apiKeyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/claude/introduction",
    models: [
      // 智谱 anthropic 兼容端点实测（2026-08-16）：thinking disabled 与
      // budget_tokens 均被忽略；仅 adaptive + output_config.effort 生效
      // （effort=low 无思考输出、max 深度思考）。故声明 forceAdaptiveThinking
      // + 档位映射；off 对端点不存在 → 声明 null，UI 选「关闭」回落「极简」
      // （= effort low，实测无思考内容）。
      {
        id: "glm-5.3",
        displayName: "GLM-5.3",
        contextWindow: 200000,
        maxTokens: 32768,
        reasoning: true,
        compat: { forceAdaptiveThinking: true },
        thinkingLevelMap: {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
      },
      {
        id: "glm-5.2",
        displayName: "GLM-5.2",
        contextWindow: 200000,
        maxTokens: 32768,
        reasoning: true,
        compat: { forceAdaptiveThinking: true },
        thinkingLevelMap: {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
      },
      {
        id: "glm-5.2[1m]",
        displayName: "GLM-5.2（100 万上下文）",
        contextWindow: 1000000,
        maxTokens: 32768,
        reasoning: true,
        compat: { forceAdaptiveThinking: true },
        thinkingLevelMap: {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
      },
    ],
  },
  {
    id: "deepseek",
    id_label: "config.preset.deepseek.name",
    baseUrl: "https://api.deepseek.com/anthropic",
    api: "anthropic-messages",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com",
    models: [
      { id: "deepseek-chat", displayName: "DeepSeek V3（对话）", contextWindow: 128000, maxTokens: 8192, reasoning: false },
      { id: "deepseek-reasoner", displayName: "DeepSeek R1（深度思考）", contextWindow: 128000, maxTokens: 65536, reasoning: true },
    ],
  },
  {
    id: "moonshot",
    id_label: "config.preset.moonshot.name",
    baseUrl: "https://api.moonshot.cn/anthropic",
    api: "anthropic-messages",
    apiKeyUrl: "https://platform.moonshot.cn/console/api-keys",
    docsUrl: "https://platform.moonshot.cn/docs",
    models: [
      { id: "kimi-k2-0905-preview", displayName: "Kimi K2", contextWindow: 262144, maxTokens: 8192, reasoning: false },
      { id: "kimi-k2-turbo-preview", displayName: "Kimi K2（极速）", contextWindow: 262144, maxTokens: 8192, reasoning: false },
    ],
  },
  {
    id: "anthropic",
    id_label: "config.preset.anthropic.name",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    docsUrl: "https://docs.anthropic.com",
    models: [
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", contextWindow: 200000, maxTokens: 64000, reasoning: true },
      { id: "claude-opus-4-7", displayName: "Claude Opus 4.7", contextWindow: 200000, maxTokens: 64000, reasoning: true },
      { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", contextWindow: 200000, maxTokens: 32000, reasoning: true },
    ],
  },
  {
    id: "openai",
    id_label: "config.preset.openai.name",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-responses",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    docsUrl: "https://platform.openai.com/docs",
    models: [
      { id: "gpt-5.1", displayName: "GPT-5.1", contextWindow: 400000, maxTokens: 128000, reasoning: true },
      { id: "gpt-5.1-codex", displayName: "GPT-5.1 Codex", contextWindow: 400000, maxTokens: 128000, reasoning: true },
      { id: "gpt-5.1-mini", displayName: "GPT-5.1 mini", contextWindow: 400000, maxTokens: 128000, reasoning: true },
    ],
  },
  {
    id: "custom",
    id_label: "config.preset.custom.name",
    baseUrl: "",
    api: "anthropic-messages",
    models: [],
  },
];

/** 按接口地址反查预设（编辑已有供应商时预选卡片）；未命中返回 null。 */
export function matchPresetByBaseUrl(baseUrl: string | undefined | null): ProviderPreset | null {
  if (!baseUrl) return null;
  const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  if (!normalized) return null;
  return (
    PROVIDER_PRESETS.find(
      (p) =>
        p.id !== "custom" &&
        p.baseUrl.trim().replace(/\/+$/, "").toLowerCase() === normalized,
    ) ?? null
  );
}

/** 推荐的 provider key（写入 models.json 的 providers 键）；重名时加序号。 */
export function suggestProviderKey(preset: ProviderPreset, existingKeys: string[]): string {
  if (preset.id === "custom") return "";
  const taken = new Set(existingKeys);
  if (!taken.has(preset.id)) return preset.id;
  let i = 2;
  while (taken.has(`${preset.id}${i}`)) i += 1;
  return `${preset.id}${i}`;
}

/** 预设模型 → models.json 模型条目（cost 按 pi schema 置 0，用户可后续在高级区改）。 */
export function presetModelToEntry(preset: ProviderModelPreset): {
  id: string;
  name: string;
  input: string[];
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
} {
  const entry: {
    id: string;
    name: string;
    input: string[];
    reasoning: boolean;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow?: number;
    maxTokens?: number;
    thinkingLevelMap?: Record<string, string | null>;
    compat?: Record<string, unknown>;
  } = {
    id: preset.id,
    name: preset.displayName,
    input: ["text"],
    reasoning: preset.reasoning ?? false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (preset.contextWindow) entry.contextWindow = preset.contextWindow;
  if (preset.maxTokens) entry.maxTokens = preset.maxTokens;
  if (preset.thinkingLevelMap) entry.thinkingLevelMap = preset.thinkingLevelMap;
  if (preset.compat) entry.compat = preset.compat;
  return entry;
}
