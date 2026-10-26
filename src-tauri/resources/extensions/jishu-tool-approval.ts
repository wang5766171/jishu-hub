/**
 * jishu-tool-approval（v0.9.3 需求22 P1：自 pi 内置扩展迁主仓部署形态——
 * 零 fork，机制同 conductor/html-preview；pi 侧内置注册与 getSetting API 已撤）。
 *
 * 逐次工具审批：每次工具调用前经 extension_ui confirm 请求 hub 决策（hub 侧
 * 策略链：只读自动放行 / 会话 Once 记忆 / 弹窗），拒绝时阻塞执行并向模型
 * 返回结构化拒绝原因。
 *
 * 模式读取改为 node:fs 直读 Pi settings.json（toolApproval 键，hub 行为设置
 * 页写入；每次评估无缓存——hub 保存即落盘，语义与原 getSetting 等价）。
 * agent 目录按 hub fork 的 piConfig.configDir 同源解析（PI_CODING_AGENT_DIR
 * 可覆盖，缺省 ~/.jishu-agent/agent）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** 审批请求标题标记：hub 侧据此区分审批型 confirm 与业务 confirm（两端同源约定）。 */
export const TOOL_APPROVAL_TITLE_PREFIX = "[jishu-tool-approval]";

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

const piAgentDir = (() => {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
  const expanded = envDir && envDir.startsWith("~") ? join(homeDir, envDir.slice(1)) : envDir;
  return expanded ? join(expanded, "agent") : join(homeDir, ".jishu-agent", "agent");
})();

/** 每次评估读盘（无缓存，hub 保存即时生效；读失败回默认 smart）。 */
function readApprovalMode(): string {
  try {
    const raw = readFileSync(join(piAgentDir, "settings.json"), "utf-8");
    const parsed = JSON.parse(raw) as { toolApproval?: unknown };
    const mode = parsed.toolApproval;
    return mode === "ask_always" || mode === "off" ? mode : "smart";
  } catch {
    return "smart";
  }
}

const jishuToolApproval: ExtensionFactory = (pi) => {
  pi.on("tool_call", async (event) => {
    const mode = readApprovalMode();
    if (mode === "off") {
      return undefined;
    }

    const summary = summarizeInput(event.input as Record<string, unknown>);
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
};

export default jishuToolApproval;
