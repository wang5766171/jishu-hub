/**
 * v0.9.8 评审修复轮 R2 / M-5：面板「每个新会话自动展开」。
 *
 * 判定要读「任务上下文在不在」，而任务上下文可能晚于会话 id 到达（冷启动恢复任务
 * 会话）。此前只在会话 id 变化时判一次：任务还没到就按「没有任务」判完了，
 * 「仅任务会话 + 每次自动展开」的面板不再展开。触发补判的必须是「有无任务」的变化，
 * 不能是任务上下文本身——任务会话里它每 3 秒换一次引用，拿它当依赖会把用户收起
 * 的面板反复弹开。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionKernelContext, SessionPluginDescriptor } from "../types";

const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));
vi.mock("@/components/dev/dev-log-center", () => ({ DevLogCenter: () => null }));

const PLUGIN_ID = "test.task-only-panel";
const plugins = vi.hoisted(() => [] as unknown[]);
vi.mock("../registry", () => ({
  listSessionPlugins: () => plugins,
  useEnabledSessionPlugins: () => new Set((plugins as Array<{ id: string }>).map((p) => p.id)),
}));

import { SessionPanelLayer } from "./session-panel-layer";
import { setPluginConfigForTest } from "../config-plane";

function Probe({ ctx }: { ctx: SessionKernelContext }) {
  return <div data-testid="probe">{ctx.sessionId}</div>;
}

const TASK = { title: "节点会话验证", total: 2, nodes: [] };
const ctxWith = (task: unknown, sessionId = "s1"): SessionKernelContext =>
  ({
    sessionId,
    task,
    messages: [],
    turns: [],
    activeTurnIndex: 0,
    subscribe: { messages: () => () => {} },
  }) as unknown as SessionKernelContext;

describe("面板自动展开 · 任务上下文晚到", () => {
  beforeAll(() => {
    plugins.push({
      id: PLUGIN_ID,
      displayNameKey: "",
      displayNameFallback: "任务看板",
      descriptionKey: "",
      descriptionFallback: "",
      source: "builtin",
      mounts: [{ kind: "dock-panel", titleKey: "", titleFallback: "任务看板", defaultSlot: "float", Component: Probe }],
    } as unknown as SessionPluginDescriptor);
  });

  beforeEach(() => {
    window.localStorage.clear();
    // 仅任务会话 + 每个新会话自动展开
    setPluginConfigForTest({ "ui.autoOpen": "every-session", "ui.scope": "task-only" }, PLUGIN_ID);
  });

  it("M5-1 任务上下文晚到：仅任务会话的面板在任务到达后自动展开", async () => {
    const view = render(<SessionPanelLayer ctx={ctxWith(null)} />);
    // 会话已确定、任务还没到：不展开
    expect(screen.queryByTestId("probe")).toBeNull();
    view.rerender(<SessionPanelLayer ctx={ctxWith({ ...TASK })} />);
    expect(await screen.findByTestId("probe")).toBeTruthy();
  });

  it("M5-2 用户收起面板后，任务上下文刷新不会把面板重新弹开", async () => {
    const view = render(<SessionPanelLayer ctx={ctxWith({ ...TASK })} />);
    await screen.findByTestId("probe");
    fireEvent.click(screen.getByTitle("收起为胶囊"));
    await waitFor(() => expect(screen.queryByTestId("probe")).toBeNull());
    // 任务会话里任务上下文定时刷新（每次都是新引用，内容可能微调）
    view.rerender(<SessionPanelLayer ctx={ctxWith({ ...TASK })} />);
    view.rerender(<SessionPanelLayer ctx={ctxWith({ ...TASK, total: 3 })} />);
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  it("M5-3 普通会话（没有任务）不展开仅任务会话的面板", async () => {
    const view = render(<SessionPanelLayer ctx={ctxWith(null)} />);
    view.rerender(<SessionPanelLayer ctx={ctxWith(null, "s2")} />);
    expect(screen.queryByTestId("probe")).toBeNull();
  });
});
