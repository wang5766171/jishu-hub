// v0.7.4：opencode 模型推荐目录（模型设置页当前模型大卡 + small model 下拉
// 数据源）。opencode 的模型 ID 为 `provider/model` 形式（官方 models 文档）；
// 由 ConfigSurface.model_catalog = "opencode" 声明启用（adapter 驱动）。
// 目录值均可被自由输入覆盖；新模型未收录时直接手输即可。

/** 自定义供应商新建时的默认 npm 适配器（opencode 生态知识，v0.7.4 审查 A6：
 *  从 opencode-providers 组件移入数据层，与目录同文件归口）。 */
export const OPENCODE_DEFAULT_PROVIDER_NPM = "@ai-sdk/openai-compatible";

export interface OpencodeModelOption {
  value: string;
  /** i18n key（config.opencodeModel.<key>） */
  labelKey: string;
}

export const OPENCODE_MODEL_CATALOG: OpencodeModelOption[] = [
  {
    value: "zhipuai-coding-plan/glm-5.1",
    labelKey: "config.opencodeModel.glm51",
  },
  {
    value: "opencode/gpt-5.1-codex",
    labelKey: "config.opencodeModel.gpt51codex",
  },
  {
    value: "anthropic/claude-sonnet-4-20250514",
    labelKey: "config.opencodeModel.sonnet4",
  },
  {
    value: "openai/gpt-5.1",
    labelKey: "config.opencodeModel.gpt51",
  },
];

/** v0.7.6 需求3：opencode 内置渠道预置（复用 opencode 原有渠道——内置
 *  provider 无需 provider 段即可在 model 中引用；密钥经 provider 段
 *  options.apiKey 覆盖写入，auth.json（/connect）优先于 config）。
 *  id/模型 2026-08-20 按本机 opencode 二进制与 models.dev 核对：
 *  - 智谱用 zhipuai-coding-plan（Coding Plan 订阅端点，模型到 glm-5.3；
 *    标准 zhipuai 走按量计费端点，Coding Plan 专属 key 对其无效——用户
 *    实测"设置智谱没生效"的根因）；
 *  - alibaba/deepseek/moonshotai 为 models.dev 收录的内置 provider
 *    （未填密钥前不出现在 opencode models 列表）。 */
export interface OpencodeChannelPreset {
  /** opencode provider id（model 引用格式 `${id}/${model}`） */
  id: string;
  /** i18n key（复用 config.preset.*.name） */
  labelKey: string;
  /** 预置模型（provider 内模型 id） */
  models: string[];
  /** 「获取密钥」官方外链 */
  apiKeyUrl?: string;
}

export const OPENCODE_CHANNEL_PRESETS: OpencodeChannelPreset[] = [
  {
    id: "zhipuai-coding-plan",
    labelKey: "config.preset.zhipu.name",
    models: ["glm-5.3", "glm-5.2", "glm-5.1"],
    apiKeyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "alibaba",
    labelKey: "config.preset.dashscope.name",
    models: ["qwen3.8-max", "qwen3.7-flash", "qwen3.5-flash"],
    apiKeyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
  },
  {
    id: "moonshotai",
    labelKey: "config.preset.moonshot.name",
    models: ["kimi-k3", "kimi-k2.7-code", "kimi-k2-thinking"],
    apiKeyUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "deepseek",
    labelKey: "config.preset.deepseek.name",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-r1"],
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
  },
];
