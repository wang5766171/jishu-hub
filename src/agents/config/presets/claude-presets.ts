// v0.7.4 需求2 R2a：claude code 代理/快速配置预设（数据源）。
//
// 派生自 provider-presets（anthropic-messages 兼容端点），附 claude 侧
// env 映射；与 template-manager 的旧 PROXY_PROVIDERS 相比，端点统一为
// Anthropic 兼容协议（旧表混入 openai 兼容地址，对 ANTHROPIC_BASE_URL
// 不生效），且两处共用同一注册表，避免清单漂移。

import { PROVIDER_PRESETS } from "./provider-presets";

export interface ClaudeProxyPreset {
  id: string;
  /** i18n key（config.preset.<id>.name） */
  labelKey: string;
  /** 写入 env.ANTHROPIC_BASE_URL（Anthropic 兼容端点） */
  baseUrl: string;
  /** 写入 env.ANTHROPIC_MODEL 的推荐模型 */
  model: string;
  /** 「获取密钥」官方外链 */
  apiKeyUrl?: string;
  /** 自定义入口（baseUrl 为空 = 不自动填） */
  custom?: boolean;
}

export const CLAUDE_PROXY_PRESETS: ClaudeProxyPreset[] = [
  ...PROVIDER_PRESETS.filter(
    (p) => p.id !== "custom" && p.id !== "anthropic" && p.api === "anthropic-messages",
  ).map((p) => ({
    id: p.id,
    labelKey: p.id_label,
    baseUrl: p.baseUrl,
    model: p.models[0]?.id ?? "",
    apiKeyUrl: p.apiKeyUrl,
  })),
  {
    id: "custom",
    labelKey: "config.preset.custom.name",
    baseUrl: "",
    model: "",
    custom: true,
  },
];

/**
 * 将预设应用到 claude 配置的 env 草稿：只写本预设涉及的三个 key
 * （合并不覆盖其他 env）；custom 且无地址时不写入。
 */
export function applyProxyPresetToEnv(
  preset: ClaudeProxyPreset,
  apiKey: string,
  env: Record<string, string>,
): Record<string, string> {
  if (preset.custom || !preset.baseUrl) return env;
  const next = { ...env };
  next["ANTHROPIC_BASE_URL"] = preset.baseUrl;
  if (apiKey.trim()) next["ANTHROPIC_AUTH_TOKEN"] = apiKey.trim();
  if (preset.model) next["ANTHROPIC_MODEL"] = preset.model;
  return next;
}

/** 代理涉及的 env key（「清除代理」时仅删这三个）。 */
export const PROXY_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
] as const;

export function removeProxyEnv(
  env: Record<string, string>,
): Record<string, string> {
  const next = { ...env };
  for (const k of PROXY_ENV_KEYS) delete next[k];
  return next;
}
