/** 修复22：会话切换（含切到新对话）收起产物侧栏——真实组件渲染测试。
 * 用户实测：A 会话 HTML 预览后点「新对话」，右半空白占位（侧栏 openId 未清）。 */
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactsSidebar } from "./artifacts";
import type { SessionKernelContext } from "../types";
import * as panelActivation from "../../shell/panel-activation";

function makeCtx(sessionId: string | null): SessionKernelContext {
  return {
    sessionId,
    messages: [],
    sessionMeta: {
      agentId: "jishu-self",
      agentName: "jishu",
      model: null,
      thinkingLevel: null,
      projectPath: "E:/JishuTest",
      projectEncodedName: "p1",
    },
    task: { nodeSessions: [] },
    openPanel: vi.fn(),
    closePanel: vi.fn(),
  } as unknown as SessionKernelContext;
}

describe("ArtifactsSidebar 会话切换收起", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("A 会话切到新对话（sessionId → null）时收起面板", async () => {
    const closeSpy = vi.fn();
    const spy = vi
      .spyOn(panelActivation, "requestPanelClose")
      .mockImplementation(() => undefined);
    // 经 ctx.closePanel 走 requestPanelClose——mock 模块函数捕获调用。
    const ctxA = { ...makeCtx("session-A"), closePanel: closeSpy } as SessionKernelContext;
    const { rerender } = render(<ArtifactsSidebar ctx={ctxA} />);
    // 切到新对话。
    const ctxNew = { ...makeCtx(null), closePanel: closeSpy } as SessionKernelContext;
    await act(async () => {
      rerender(<ArtifactsSidebar ctx={ctxNew} />);
    });
    expect(closeSpy).toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled(); // ctx.closePanel 由壳层接线，此处直调 mock
  });
});
