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

export interface ModelFormValue {
  id: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  inputText: boolean;
  inputImage: boolean;
  baseUrl: string;
  api: string;
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
  return entry;
}
