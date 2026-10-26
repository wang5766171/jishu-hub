// v0.7.5 需求7：codex 中转服务商预设注册表（中转模版补填弹窗数据源，
// 与 claude 的 claude-presets.ts 同层——「预设是前端注册表」的既定模式）。
//
// 端点依据（2026-08-18 官方文档核对）：
// - DeepSeek：官方原生支持 Responses API（api-docs.deepseek.com「接入 Codex」）
// - 智谱：GLM Coding Plan 官方 Codex 接入文档
//   （docs.bigmodel.cn/cn/coding-plan/tool/codex，base_url=/api/v1）
// - 自定义：任意 Responses 兼容端点（Chat Completions 兼容 ≠ Responses 兼容）

export interface CodexProxyPreset {
  id: string;
  /** i18n key（复用 config.preset.*.name 文案体系） */
  labelKey: string;
  /** Responses/Chat 端点（custom 为空 = 手填） */
  baseUrl: string;
  /** 默认模型（custom 为空 = 手填） */
  model: string;
  /** 渠道可用模型候选（v0.7.6 需求2：模型下拉按渠道预置） */
  models: string[];
  /** 密钥环境变量名（写入 model_providers.<id>.env_key） */
  envKey: string;
  /** codex wire_api：responses（OpenAI Responses）或 chat（chat
   *  completions 兼容端点，如百炼/KIMI；v0.7.6 需求3）。默认 responses。 */
  wireApi?: "chat" | "responses";
  /** 「获取密钥」官方外链（v0.7.6 需求3） */
  apiKeyUrl?: string;
}

export const CODEX_PROXY_PRESETS: CodexProxyPreset[] = [
  {
    id: "zhipu",
    labelKey: "config.preset.zhipu.name",
    baseUrl: "https://open.bigmodel.cn/api/v1",
    model: "glm-5.3",
    models: ["glm-5.3", "glm-5.2", "glm-5.2[1m]"],
    envKey: "ZHIPU_API_KEY",
    apiKeyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    // v0.7.6 需求3：百炼 Token Plan（个人版/团队版）订阅专用 Responses
    // 端点（help.aliyun.com/zh/model-studio/codex，2026-08-20 核对）——新版
    // codex 走 wire_api="responses"；密钥为 Token Plan 专属，与按量计费
    // 互不相通。Coding Plan 的 chat 端点已被新版 codex 废弃，不预置。
    id: "dashscope",
    labelKey: "config.preset.dashscope.name",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-max",
    models: ["qwen3.8-max", "qwen3.7-plus", "qwen3.7-max"],
    envKey: "DASHSCOPE_API_KEY",
    apiKeyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
  },
  {
    // v0.7.6 需求3：KIMI OpenAI 兼容端点（chat completions → wire_api=chat）。
    id: "moonshot",
    labelKey: "config.preset.moonshot.name",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2-0905-preview",
    models: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview"],
    envKey: "MOONSHOT_API_KEY",
    wireApi: "chat",
    apiKeyUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "deepseek",
    labelKey: "config.preset.deepseek.name",
    baseUrl: "https://api.deepseek.com/",
    model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    envKey: "DEEPSEEK_API_KEY",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "custom",
    labelKey: "config.preset.custom.name",
    baseUrl: "",
    model: "",
    models: [],
    envKey: "CUSTOM_API_KEY",
  },
];

/** 官方直连态的 OpenAI 模型预置（与 PROVIDER_PRESETS openai 条目同源；
 *  v0.7.6 需求2：codex 模型下拉直连态也有预置可选）。 */
/** 自定义模型记忆（localStorage，按渠道隔离；"direct" = 直连态）。
 *  模型 ID 不落 codex 原生配置——列表是纯前端候选补充，避免污染
 *  config.toml；渠道切换后各自记忆互不串扰。 */
const CUSTOM_MODELS_STORAGE_KEY = "jishu-hub:codex-custom-models";

function loadCustomModelMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(CUSTOM_MODELS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => [k, (v as unknown[]).filter((m): m is string => typeof m === "string")]),
    );
  } catch {
    return {};
  }
}

/** 读取渠道的自定义模型候选（异常环境降级为空列表）。 */
export function codexCustomModelsFor(providerId: string): string[] {
  return loadCustomModelMap()[providerId] ?? [];
}

/** 追加渠道自定义模型（去重、保持插入序；不可用时静默忽略）。 */
export function rememberCodexCustomModel(providerId: string, model: string): void {
  const id = model.trim();
  if (!id) return;
  try {
    const map = loadCustomModelMap();
    const list = map[providerId] ?? [];
    if (list.includes(id)) return;
    map[providerId] = [...list, id];
    localStorage.setItem(CUSTOM_MODELS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage 不可用（隐私模式等）时仅放弃记忆，不影响选择本身
  }
}

/** 删除渠道自定义模型（v0.7.6 需求3 迭代六：渠道模型列表的删除入口）。 */
export function removeCodexCustomModel(providerId: string, model: string): void {
  try {
    const map = loadCustomModelMap();
    const list = map[providerId];
    if (!list?.includes(model)) return;
    map[providerId] = list.filter((m) => m !== model);
    localStorage.setItem(CUSTOM_MODELS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 同上：记忆层失败静默
  }
}
