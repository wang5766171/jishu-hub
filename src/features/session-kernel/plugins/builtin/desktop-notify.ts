import i18next from "i18next";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor } from "../types";

/**
 * 桌面通知插件（v0.9.2 需求1 M4，用户圈定首期 #28）——event-hook 挂载点
 * 的首个真实使用者。hub 是任务型产品，长任务执行时用户切走是常态：
 * 回合完成（后台会话）/需审批/任务失败 三类信号发系统级通知。
 * 订阅由通用信号桥（mounts/plugin-signal-bridge）挂接，插件只声明 onSignal。
 */

let permissionRequested = false;

async function ensurePermission(): Promise<boolean> {
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    let granted = await mod.isPermissionGranted();
    if (!granted && !permissionRequested) {
      permissionRequested = true;
      granted = (await mod.requestPermission()) === "granted";
    }
    return granted;
  } catch {
    return false;
  }
}

async function notify(title: string, body: string): Promise<void> {
  if (!(await ensurePermission())) return;
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    mod.sendNotification({ title, body });
  } catch {
    // 通知失败静默（不影响会话功能）
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
  mounts: [
    {
      kind: "event-hook",
      onSignal(signal) {
        switch (signal.type) {
          case "turn-complete":
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
            );
            break;
          case "approval-request":
            void notify(
              t("sessionPlugins.desktopNotify.approvalTitle", "等待审批"),
              t("sessionPlugins.desktopNotify.approvalBody", "会话请求人工审批"),
            );
            break;
          case "task-run-failed":
            void notify(
              t("sessionPlugins.desktopNotify.taskFailedTitle", "任务失败"),
              t("sessionPlugins.desktopNotify.taskFailedBody", "「{{title}}」执行失败", {
                title: signal.title,
              }),
            );
            break;
        }
      },
    },
  ],
};
