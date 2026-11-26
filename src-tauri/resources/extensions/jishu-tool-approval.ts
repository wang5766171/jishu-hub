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
import type {
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

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

/** 需求22（v0.9.8 评审修复轮 R2）：本会话的「不询问」——以 hub 的任务登记
 * 为准。hubInvoke 桥（与 runner 扩展同机制）：select 标题携带 {command, params}
 * JSON，hub 识别后直达后端，响应 value 为 {success, data} JSON 字符串。
 * 每轮开始时问一次（before_agent_start），工具调用期读这份缓存。
 *
 * hub 没回答、回答不了、或说不是：一律照常审批——宁可多问，不放错通道。
 * 此前读的是 Pi settings.json 的全局键 taskNoAsk：任一会话打开，所有任务
 * 会话一起跳过审批。 */
async function queryNoAsk(ctx: ExtensionContext): Promise<boolean> {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return false;
    const payload = JSON.stringify({
      command: "runner_capability_plugins",
      params: { session_id: sessionId, project_root: process.cwd() },
    });
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 3000),
    );
    const result = await Promise.race([
      ctx.ui.select(`\x00hub_invoke:${payload}`, ["\x00ok"]),
      timeoutPromise,
    ]);
    if (!result) return false;
    const parsed = JSON.parse(result) as {
      success?: boolean;
      data?: { taskSession?: boolean; noAsk?: boolean };
    };
    return (
      parsed.success === true &&
      parsed.data?.taskSession === true &&
      parsed.data?.noAsk === true
    );
  } catch {
    return false;
  }
}

const jishuToolApproval: ExtensionFactory = (pi) => {
  let noAsk = false;
  pi.on("before_agent_start", async (_event, ctx) => {
    noAsk = await queryNoAsk(ctx);
  });
  pi.on("tool_call", async (event, ctx) => {
    const mode = readApprovalMode();
    // off 仍全局生效；不询问只对本任务是任务会话、且开了开关的会话生效
    //（普通对话、别的任务的会话照常走审批链）。
    if (mode === "off" || noAsk) {
      return undefined;
    }

    const summary = summarizeInput(event.input as Record<string, unknown>);
    const title = `${TOOL_APPROVAL_TITLE_PREFIX}${mode}|${event.toolName}`;
    const message = summary || `执行工具 ${event.toolName}`;

    // v0.9.6 补充⑫（去 fork）：事件处理器第二参数即上游 ctx（ExtensionContext，
    // 含 ui）——替代原 fork pi.context 桥，与 conductor/html-preview 形态统一。
    const approved = await ctx.ui.confirm(title, message, { timeout: 120_000 });
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
