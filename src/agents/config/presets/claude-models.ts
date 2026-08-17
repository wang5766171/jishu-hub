// v0.7.4 需求2 R2a：claude 模型推荐目录（config-sections 模型区数据源）。
// 替代旧硬编码 MODEL_OPTIONS（仅 3 项）；目录值均可被自由输入覆盖，
// 当前已配置值会自动置顶显示。新模型发布未收录时直接手输即可。

export interface ClaudeModelOption {
  value: string;
  /** i18n key（config.claudeModel.<key>） */
  labelKey: string;
}

export const CLAUDE_MODEL_CATALOG: ClaudeModelOption[] = [
  { value: "claude-sonnet-4-6", labelKey: "config.claudeModel.sonnet46" },
  { value: "claude-opus-4-7", labelKey: "config.claudeModel.opus47" },
  { value: "claude-haiku-4-5-20251001", labelKey: "config.claudeModel.haiku45" },
  { value: "claude-sonnet-4-5", labelKey: "config.claudeModel.sonnet45" },
  { value: "claude-opus-4-5", labelKey: "config.claudeModel.opus45" },
  { value: "claude-opus-4-1-20250805", labelKey: "config.claudeModel.opus41" },
  { value: "claude-sonnet-4-20250514", labelKey: "config.claudeModel.sonnet4" },
];

/** 判断 claude env 是否已配置代理（存在即视为代理态）。 */
export function detectProxyFromEnv(
  env: Record<string, string> | null | undefined,
): string | null {
  const baseUrl = env?.["ANTHROPIC_BASE_URL"]?.trim();
  return baseUrl ? baseUrl : null;
}
