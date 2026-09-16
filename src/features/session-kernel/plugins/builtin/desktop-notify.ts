import i18next from "i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import { cfgBool, getPluginConfig, type PluginConfigField } from "../config-plane";
import type { SessionPluginDescriptor } from "../types";

/**
 * 桌面通知插件（v0.9.2 需求1 M4，用户圈定首期 #28）——event-hook 挂载点
 * 的首个真实使用者。hub 是任务型产品，长任务执行时用户切走是常态：
 * 回合完成（后台会话）/需审批/任务失败 三类信号发系统通知。
 * 订阅由通用信号桥（mounts/plugin-signal-bridge）挂接，插件只声明 onSignal。
 *
 * v0.9.3 测试期（三轮定稿）：
 * ① Web Notification 双通道在 WebView2 静默不显示——已删；
 * ② 官方 JS 插件 API 吞错——改走自建命令 desktop_notify_send（notify-rust
 *   同底层，同步执行错误如实返回）；
 * ③ 点击跳回：protocol toast + deep-link 链路——Rust 聚焦主窗 + 广播
 *   desktop-notify-click（含 session_id）；**会话定位由 chat-page 直接监听
 *   该事件并调 handleSelectSession**（不再经本插件 lastCtx 间接层——冷启动
 *   与未发过通知的场景同样可靠）。
 * 触发口径：turn-complete 仅后台会话发（正在查看的会话不打扰）。
 */

/** v0.9.3 需求12 P1：触发口径（原三类全开）/提示音（原固定响）/静音时段
 * （原无）配置化——event-hook 消费经 getPluginConfig 同步快照。 */
const NOTIFY_CONFIG_SCHEMA: PluginConfigField[] = [
  { key: "notifyTurnComplete", type: "switch", label: "回合完成通知", description: "后台会话回复完毕时通知（正在查看的会话不打扰）", default: true },
  { key: "notifyApproval", type: "switch", label: "审批请求通知", default: true },
  { key: "notifyTaskFailed", type: "switch", label: "任务失败通知", default: true },
  { key: "sound", type: "switch", label: "提示音", default: true },
  {
    key: "quietHours",
    type: "text",
    label: "静音时段",
    description: "格式 HH:mm-HH:mm（如 22:00-08:00），期间只弹不响仍受提示音开关控制之外的整段静默；留空不静音",
    default: "",
    placeholder: "HH:mm-HH:mm",
  },
];

/** 静音时段判断（HH:mm-HH:mm，跨零点区间支持；空/格式错 = 不静音）。 */
function inQuietHours(range: string, now = new Date()): boolean {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(range.trim());
  if (!m) return false;
  const toMin = (h: string, min: string) => Number(h) * 60 + Number(min);
  const start = toMin(m[1], m[2]);
  const end = toMin(m[3], m[4]);
  const cur = now.getHours() * 60 + now.getMinutes();
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

async function notify(title: string, body: string, sessionId?: string): Promise<void> {
  const cfg = getPluginConfig("session.desktop-notify", NOTIFY_CONFIG_SCHEMA);
  const quiet = inQuietHours(String(cfg.quietHours ?? ""));
  try {
    await invokeCommand<string>("desktop_notify_send", {
      title,
      body,
      sessionId: sessionId ?? null,
      sound: !quiet && cfgBool(cfg, "sound", true) ? null : false,
    });
  } catch (error) {
    console.warn("desktop notify failed:", error);
  }
}

const t = (key: string, fallback: string, vars?: Record<string, string>) =>
  i18next.t(key, { defaultValue: fallback, ...(vars ?? {}) });

export const desktopNotifyPlugin: SessionPluginDescriptor = {
  id: "session.desktop-notify",
  displayNameKey: "sessionPlugins.desktopNotify.name",
  displayNameFallback: "桌面通知",
  descriptionKey: "sessionPlugins.desktopNotify.description",
  descriptionFallback: "回合完成、需审批、任务失败时发送系统通知",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["subscribe:signals"],
  configSchema: NOTIFY_CONFIG_SCHEMA,
  mounts: [
    {
      kind: "event-hook",
      onSignal(signal) {
        // 触发口径门控（需求12 P1：三类触发各一开关）。
        const cfg = getPluginConfig("session.desktop-notify", NOTIFY_CONFIG_SCHEMA);
        switch (signal.type) {
          case "turn-complete":
            if (!cfgBool(cfg, "notifyTurnComplete", true)) return;
            void notify(
              signal.error
                ? t("sessionPlugins.desktopNotify.turnFailed", "回合失败")
                : t("sessionPlugins.desktopNotify.turnDone", "回合完成"),
              t("sessionPlugins.desktopNotify.turnBody", "会话 {{id}}… {{state}}", {
                id: signal.sessionId.slice(0, 12),
                state: signal.error
                  ? t("sessionPlugins.desktopNotify.stateError", "执行出错")
                  : t("sessionPlugins.desktopNotify.stateDone", "已回复完毕"),
              }),
              signal.sessionId,
            );
            break;
          case "approval-request":
            if (!cfgBool(cfg, "notifyApproval", true)) return;
            void notify(
              t("sessionPlugins.desktopNotify.approvalTitle", "等待审批"),
              t("sessionPlugins.desktopNotify.approvalBody", "会话请求人工审批"),
              signal.sessionId,
            );
            break;
          case "task-run-failed":
            if (!cfgBool(cfg, "notifyTaskFailed", true)) return;
            void notify(
              t("sessionPlugins.desktopNotify.taskFailedTitle", "任务失败"),
              t("sessionPlugins.desktopNotify.taskFailedBody", "「{{title}}」执行失败", {
                title: signal.title,
              }),
              // 任务导航暂无契约命令（ctx 无 switchTask）——点击仅聚焦应用。
            );
            break;
        }
      },
    },
  ],
};
