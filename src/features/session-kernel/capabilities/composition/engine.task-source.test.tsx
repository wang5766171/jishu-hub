/**
 * 组合引擎——「源 = 任务」的数据面挂件跟着任务上下文重算。
 * v0.9.8 需求24 续，对应 tests/06-测试清单 S24-U16。
 *
 * 任务看板这类面板的显示内容由任务上下文算出来。进入任务时任务图还没加载（上下文里没有图），
 * 加载完成后上下文变了——面板必须跟着重算。此前计算显示内容的缓存依赖里漏了任务上下文：
 * 面板挂载后一直停在挂载那一刻的样子（进入带任务图的任务，看板停在「0/0」、没有节点也
 * 没有「主会话」入口；只有主会话来了新消息才顺带刷新）。
 */
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import type { SessionKernelContext } from "../../plugins/types";
import { buildComposedDescriptor } from "./engine";
import { rendererRegistry } from "../renderers/registry";
import type { SessionComposedManifest } from "../types";

const KEY = "render.test-task-board-follows-context";

type BoardPayload = { kind: string; task: { title: string; total: number } | null };

/** 与真实的任务看板清单同形：源 = 任务，挂在浮窗位。 */
function Probe({ payload }: { payload: BoardPayload }) {
  return (
    <div data-testid="board">
      {payload.kind === "task" && payload.task ? `${payload.task.title}:${payload.task.total}` : "无任务"}
    </div>
  );
}

const ctxWith = (task: BoardPayload["task"], shared: { messages: unknown[]; turns: unknown[] }): SessionKernelContext =>
  // 消息与轮次沿用同一份数组（真实应用里任务图加载不改变它们）——只有任务上下文在变
  ({ messages: shared.messages, turns: shared.turns, activeTurnIndex: 0, task, sessionId: "s1" }) as unknown as SessionKernelContext;

describe("数据面挂件 · 任务上下文变化后跟着重算", () => {
  beforeAll(() => {
    rendererRegistry.register({ key: KEY, component: Probe as never });
  });

  it("进入任务时还没有图（0 个节点）→ 图加载完（2 个节点）→ 取消关联：面板三次都跟着变——S24-U16", () => {
    const manifest: SessionComposedManifest = {
      plugin: { id: "test.task-board-follows-context", name: "任务看板" },
      kind: "session-composed",
      source: { type: "task" },
      render: { component: KEY, mount: "dock-panel" },
    };
    const desc = buildComposedDescriptor(manifest);
    const mount = desc.mounts[0] as unknown as { Component: (props: { ctx: SessionKernelContext }) => React.JSX.Element };
    const shared = { messages: [], turns: [] };
    const view = render(<mount.Component ctx={ctxWith({ title: "节点会话验证", total: 0 }, shared)} />);
    expect(screen.getByTestId("board").textContent).toBe("节点会话验证:0");

    view.rerender(<mount.Component ctx={ctxWith({ title: "节点会话验证", total: 2 }, shared)} />);
    expect(screen.getByTestId("board").textContent).toBe("节点会话验证:2");

    view.rerender(<mount.Component ctx={ctxWith(null, shared)} />);
    expect(screen.getByTestId("board").textContent).toBe("无任务");
  });
});
