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

/** 需求2 追加：任务不询问模式（Pi settings taskNoAsk）——开启时逐次审批
 * 直接放行（用户裁决：全都按 agent 推荐执行）。每次评估现读现用。
 * 评审 P2-⑩（用户裁决）：**不询问仅任务会话生效**——非任务会话（普通
 * 对话/子会话）照常走审批链。 */
function readTaskNoAsk(): boolean {
  try {
    const raw = readFileSync(join(piAgentDir, "settings.json"), "utf-8");
    const parsed = JSON.parse(raw) as { taskNoAsk?: unknown };
    return parsed.taskNoAsk === true;
  } catch {
    return false;
  }
}

/** 评审 P2-⑩：判定当前会话是否任务会话——读会话 appendEntry（runner 扩展
 * 持久化的共享状态 `jishu-task-runner`，与 runner session_start 恢复同源），
 * 存在非空 taskId 才认定。读不到/无任务 → false（宁可多审批，不放错通道）。 */
function isTaskSession(ctx: ExtensionContext): boolean {
  try {
    type Entry = {
      type?: string;
      customType?: string;
      data?: { taskId?: string };
    };
    const entries = ctx.sessionManager.getEntries() as Entry[];
    const last = entries
      .filter(
        (entry) => entry?.type === "custom" && entry?.customType === "jishu-task-runner",
      )
      .pop();
    return typeof last?.data?.taskId === "string" && last.data.taskId.length > 0;
  } catch {
    return false;
  }
}

const jishuToolApproval: ExtensionFactory = (pi) => {
  pi.on("tool_call", async (event, ctx) => {
    const mode = readApprovalMode();
    // 评审 P2-⑩：taskNoAsk 只在能确认当前会话为任务会话时跳审批，否则
    // 照常走审批链（off 仍全局生效）。
    if (mode === "off" || (readTaskNoAsk() && isTaskSession(ctx))) {
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
