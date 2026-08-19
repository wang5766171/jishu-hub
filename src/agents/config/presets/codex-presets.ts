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
  /** Responses 端点（custom 为空 = 手填） */
  baseUrl: string;
  /** 默认模型（custom 为空 = 手填） */
  model: string;
  /** 密钥环境变量名（写入 model_providers.<id>.env_key） */
  envKey: string;
}

export const CODEX_PROXY_PRESETS: CodexProxyPreset[] = [
  {
    id: "deepseek",
    labelKey: "config.preset.deepseek.name",
    baseUrl: "https://api.deepseek.com/",
    model: "deepseek-chat",
    envKey: "DEEPSEEK_API_KEY",
  },
  {
    id: "zhipu",
    labelKey: "config.preset.zhipu.name",
    baseUrl: "https://open.bigmodel.cn/api/v1",
    model: "glm-5.3",
    envKey: "ZHIPU_API_KEY",
  },
  {
    id: "custom",
    labelKey: "config.preset.custom.name",
    baseUrl: "",
    model: "",
    envKey: "CUSTOM_API_KEY",
  },
];
