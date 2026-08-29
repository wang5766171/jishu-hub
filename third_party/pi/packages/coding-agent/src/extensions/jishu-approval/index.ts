/**
 * jishu-tool-approval（v0.84.2-11，jishu-hub v0.8.0 需求1 P-2）：
 * 逐次工具审批扩展。每次工具调用前经 extension_ui confirm 请求 hub 决策
 * （hub 侧策略链：只读自动放行 / 会话 Once 记忆 / 弹窗），拒绝时阻塞执行
 * 并向模型返回结构化拒绝原因。
 *
 * 模式（Pi settings `toolApproval`，hub 行为设置页写入）：
 * - "smart"（默认）：hub 策略链 [Once, LowRiskAutoAllow]——只读零打扰；
 * - "ask_always"：hub 空链——每次弹窗；
 * - "off"：本扩展直接放行，不发起请求（回到 v0.8.0 之前行为）。
 */

import type { ExtensionFactory } from "../../core/extensions/types.ts";

/** 审批请求标题标记：hub 侧据此区分审批型 confirm 与业务 confirm。
 * 两端常量同源约定（PI_CHANGE 附录登记）。 */
export const TOOL_APPROVAL_TITLE_PREFIX = "[jishu-tool-approval]";

/** 输入摘要的常见键（截断至 ~200 字符）。 */
const SUMMARY_KEYS = ["file_path", "path", "filename", "command", "pattern", "url"];

function summarizeInput(input: Record<string, unknown> | undefined): string {
	if (!input) return "";
	for (const key of SUMMARY_KEYS) {
		const value = input[key];
		if (typeof value === "string" && value) {
			return value.length > 200 ? `${value.slice(0, 200)}…` : value;
		}
		if (Array.isArray(value)) {
			const joined = value.filter((v) => typeof v === "string").join(" ");
			if (joined) return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined;
		}
	}
	return "";
}

const jishuToolApproval: { name: string; factory: ExtensionFactory; hidden?: boolean } = {
	name: "jishu-tool-approval",
	factory: (pi) => {
		pi.on("tool_call", async (event) => {
			// 模式读取：每次评估（hub 保存后即时生效，无缓存）。
			const rawMode = pi.context.getSetting?.<string>("toolApproval");
			const mode = rawMode === "ask_always" || rawMode === "off" ? rawMode : "smart";
			if (mode === "off") {
				return undefined;
			}

			const summary = summarizeInput(event.input as Record<string, unknown>);
			// 标题携带模式（hub 按模式装配策略链）与工具名；正文为输入摘要。
			const title = `${TOOL_APPROVAL_TITLE_PREFIX}${mode}|${event.toolName}`;
			const message = summary || `执行工具 ${event.toolName}`;

			const approved = await pi.context.ui.confirm(title, message, { timeout: 120_000 });
			if (approved) {
				return undefined;
			}
			return {
				block: true,
				reason: `用户拒绝了此操作（工具 ${event.toolName}）`,
			};
		});
	},
};

export default jishuToolApproval;
