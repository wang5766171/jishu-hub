// 权限模式值集与文案 key 的单一来源（v0.7.4 审查 A7 收敛，v0.7.5 实施）。
// 值即契约（v0.7.3 需求2 P-3）：模式值由各 adapter 声明或其原生配置决定，
// 前端只维护「值 → 本地化文案」展示字典——新增模式值时只改本文件。

/** claude permissions.defaultMode 的可选值（adapter access_modes 同源）。 */
export const CLAUDE_PERMISSION_MODES = ["default", "bypassPermissions", "plan"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/** claude 权限模式 → 短标签 i18n key（下拉/列表用；卡片标题/描述见
 *  permission-cards.tsx 的 permCard.* 键）。 */
export const PERMISSION_MODE_LABEL_KEYS: Record<ClaudePermissionMode, string> = {
  default: "config.modeDefault",
  bypassPermissions: "config.modeBypass",
  plan: "config.modePlan",
};

/** jishu 工具模式（Hub agent_tool_mode，full/readonly）。 */
export const TOOL_MODES = ["full", "readonly"] as const;
export type ToolMode = (typeof TOOL_MODES)[number];

export const TOOL_MODE_LABEL_KEYS: Record<ToolMode, string> = {
  full: "config.toolMode.full.title",
  readonly: "config.toolMode.readonly.title",
};
