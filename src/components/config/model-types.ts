// v0.7.4 需求2 R1：pi models.json 前端共享类型与转换函数。
// 自 model-manager.tsx 原样迁出（§18 零逻辑变更拆分），供
// model-manager / provider-form / model-form 三处共用。

export interface ActiveModel {
  provider: string;
  model: string;
}

export interface PiModelEntry {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  headers?: Record<string, string>;
  [extra: string]: unknown;
}

export interface PiProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  authHeader?: boolean;
  models?: PiModelEntry[];
  modelOverrides?: Record<string, Record<string, unknown>>;
  [extra: string]: unknown;
}

export interface PiModelsConfig {
  providers: Record<string, PiProviderConfig>;
}

export interface HeaderRow {
  key: string;
  value: string;
}

/** Pi 思考档位全集（顺序即收敛查找顺序）。 */
export const THINKING_LEVEL_ALL = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * 从 models.json 的 thinkingLevelMap 声明推导「支持的档位」列表。
 * 语义与 Pi getSupportedThinkingLevels 一致：值为 null = 不支持；
 * xhigh/max 需显式声明（mapped !== undefined）才支持；无声明时默认
 * off..high。v0.7.4 A7 修复：GLM-5.3 等不支持关闭思考的模型由此收敛。
 */
/**
 * v0.8.0 需求3 边界声明：会话页/行为页的档位候选已收敛至聚合 IPC
 * （get_model_picker_options，后端唯一解析）。本函数仅服务**模型表单的
 * 编辑初始化**（把已存在的 thinkingLevelMap 反显为勾选）——与后端
 * supported_thinking_levels 语义逐条对齐（单测锁定），Pi 语义变化时
 * 两端同步修改。
 */
export function supportedThinkingLevels(map?: Record<string, unknown>): string[] {
  if (!map) return ["off", "minimal", "low", "medium", "high"];
  return THINKING_LEVEL_ALL.filter((lvl) => {
    const mapped = map[lvl];
    if (mapped === null) return false; // 显式声明不支持
    if (lvl === "xhigh" || lvl === "max") return mapped !== undefined; // 需显式声明
    return true; // off..high 未声明 = 默认支持
  });
}

/** 由支持的档位列表构造 thinkingLevelMap 声明（全默认时返回 undefined，保持文件干净）。 */
export function thinkingLevelMapFromSupported(supported: string[]): Record<string, string | null> | undefined {
  const map: Record<string, string | null> = {};
  let hasDeclaration = false;
  for (const lvl of THINKING_LEVEL_ALL) {
    const isSupported = supported.includes(lvl);
    const isDefault = lvl !== "xhigh" && lvl !== "max"; // 默认支持 off..high
    if (isSupported === isDefault) continue;
    hasDeclaration = true;
    map[lvl] = isSupported ? lvl : null;
  }
  return hasDeclaration ? map : undefined;
}

export interface ModelFormValue {
  id: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  inputText: boolean;
  inputImage: boolean;
  baseUrl: string;
  api: string;
  /** 支持的思考档位（reasoning=true 时有意义；见 supportedThinkingLevels）。 */
  thinkingLevels: string[];
}

export function emptyModelValue(): ModelFormValue {
  return {
    id: "",
    contextWindow: "128000",
    maxTokens: "8192",
    reasoning: false,
    inputText: true,
    inputImage: false,
    baseUrl: "",
    api: "",
    thinkingLevels: ["off", "minimal", "low", "medium", "high"],
  };
}

export function modelToValue(m: PiModelEntry): ModelFormValue {
  return {
    id: m.id,
    contextWindow: String(m.contextWindow ?? "128000"),
    maxTokens: String(m.maxTokens ?? "8192"),
    reasoning: m.reasoning ?? false,
    inputText: m.input?.includes("text") ?? true,
    inputImage: m.input?.includes("image") ?? false,
    baseUrl: m.baseUrl ?? "",
    api: m.api ?? "",
    thinkingLevels: supportedThinkingLevels(m.thinkingLevelMap as Record<string, unknown> | undefined),
  };
}

export function valueToModel(v: ModelFormValue): PiModelEntry {
  const input: string[] = [];
  if (v.inputText) input.push("text");
  if (v.inputImage) input.push("image");
  const entry: PiModelEntry = {
    id: v.id.trim(),
    name: v.id.trim(),
    input,
    reasoning: v.reasoning,
    // Pi's ModelDefinitionSchema requires `cost` to be present with
    // all four numeric fields. We default to 0s; the user can edit
    // individual values from the JSON editor if they care about
    // per-million-token pricing.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const cw = parseInt(v.contextWindow, 10);
  if (!Number.isNaN(cw)) entry.contextWindow = cw;
  const mt = parseInt(v.maxTokens, 10);
  if (!Number.isNaN(mt)) entry.maxTokens = mt;
  if (v.api.trim()) entry.api = v.api.trim();
  if (v.baseUrl.trim()) entry.baseUrl = v.baseUrl.trim();
  if (v.reasoning) {
    const map = thinkingLevelMapFromSupported(v.thinkingLevels);
    if (map) entry.thinkingLevelMap = map;
  }
  return entry;
}
