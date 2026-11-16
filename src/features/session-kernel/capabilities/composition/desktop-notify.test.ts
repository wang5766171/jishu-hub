import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * v0.9.5 需求1 测试期（用户实测「系统通知没有效果了」）：桌面通知链路
 * 端到端回归——真实内置清单（desktop-notify.toml 的 JSON 形状）→ 组合引擎
 * 装配 → 事件钩子 onSignal → desktop-notify 动作 → desktop_notify_send IPC。
 * 断链点排查用：本测试绿 = 前端链路完整（问题在后端/系统层）。
 */

const invokeMock = vi.fn(async (..._args: unknown[]) => null);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { buildComposedDescriptor } from "./engine";
// 真实注册表侧_effects：primitives 注册 render.none 等原语（与 registry.ts
// 的应用内装载同源）；actions 注册真实动作实现（含 desktop-notify）。
import "@/features/session-kernel/capabilities/renderers/components/primitives";
import "@/features/session-kernel/capabilities/actions";
import { rendererRegistry } from "../renderers/registry";
import { setPluginConfigForTest } from "../../plugins/config-plane";

/** desktop-notify.toml（src-tauri/resources/composed-plugins）的 JSON 形状——
 *  Rust toml 解析后透传给前端的形状，逐字段对齐清单文件。 */
function desktopNotifyManifest() {
  return {
    plugin: {
      id: "session.desktop-notify",
      name: "桌面通知",
      description: "回合完成、需审批、任务失败时发送系统通知",
      kind: "session-composed",
    },
    kind: "session-composed" as const,
    source: {
      type: "signal" as const,
      signals: ["turn-complete", "approval-request", "task-run-failed"],
    },
    render: { component: "render.none", mount: "event-hook" as const },
    action: [{ type: "desktop-notify" as const }],
    config: [
      { key: "notifyTurnComplete", type: "switch" as const, label: "回合完成通知", description: "后台会话回复完毕时通知（正在查看的会话不打扰）", default: true },
      { key: "notifyApproval", type: "switch" as const, label: "审批请求通知", default: true },
      { key: "notifyTaskFailed", type: "switch" as const, label: "任务失败通知", default: true },
      { key: "sound", type: "switch" as const, label: "提示音", default: true },
      { key: "quietHours", type: "text" as const, label: "静音时段", description: "格式 HH:mm-HH:mm（如 22:00-08:00），留空不静音", default: "", placeholder: "HH:mm-HH:mm" },
    ],
  };
}

interface EventHookMountLike {
  kind: string;
  onSignal: (signal: unknown, ctx: unknown) => void;
}

function hookOf(): EventHookMountLike {
  const desc = buildComposedDescriptor(desktopNotifyManifest() as never);
  const hook = desc.mounts.find((m) => m.kind === "event-hook") as EventHookMountLike | undefined;
  if (!hook) throw new Error("event-hook 挂载缺失——组合装配失败");
  return hook;
}

describe("桌面通知链路（desktop-notify 清单端到端）", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    setPluginConfigForTest({});
  });

  it("装配：真实清单产出 event-hook 挂载（render.none 已注册）", () => {
    expect(rendererRegistry.get("render.none")).toBeTruthy();
    const hook = hookOf();
    expect(hook.kind).toBe("event-hook");
  });

  it("turn-complete 信号 → desktop_notify_send（标题/会话定位/声音默认）", () => {
    const hook = hookOf();
    hook.onSignal(
      { type: "turn-complete", sessionId: "session-bg-123456", agentId: "jishu-self", error: false },
      { sessionId: "other-viewed" },
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("desktop_notify_send");
    expect(args.title).toBe("回合完成");
    expect(String(args.body)).toContain("session-bg-");
    expect(args.sessionId).toBe("other-viewed");
    expect(args.sound).toBe(null);
  });

  it("approval-request 信号 → 等待审批通知", () => {
    const hook = hookOf();
    hook.onSignal({ type: "approval-request", sessionId: "s1", agentId: "jishu-self" }, { sessionId: "s2" });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect((invokeMock.mock.calls[0] as [string, Record<string, unknown>])[1].title).toBe("等待审批");
  });

  it("未订阅信号（session-titled 等）不触发通知", () => {
    const hook = hookOf();
    hook.onSignal({ type: "session-titled", sessionId: "s1", title: "x" }, { sessionId: "s1" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("门控：notifyTurnComplete=false 时不发通知（配置面数据驱动）", () => {
    // 直写真实插件 id 的用户配置（引擎 onSignal 经 getPluginConfigSync 读）。
    setPluginConfigForTest({ notifyTurnComplete: false }, "session.desktop-notify");
    const hook = hookOf();
    hook.onSignal({ type: "turn-complete", sessionId: "s1", agentId: "a", error: false }, { sessionId: "s2" });
    expect(invokeMock).not.toHaveBeenCalled();
    // 独立开关不误伤：关掉回合完成，审批通知仍放行。
    hook.onSignal({ type: "approval-request", sessionId: "s1", agentId: "a" }, { sessionId: "s2" });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
