/**
 * 扩展命令的流不留用户气泡——二轮评审 R3（域 1 P2-4）。
 *
 * 扩展命令由引擎直接执行、不落用户消息（与 pi 原生 TUI 一致：命令执行完就回到输入提示）。
 * 修前执行期间先出一个带编辑入口的用户气泡、结束后整条消失。组件用真的；流式状态仓库
 * 同 streaming-message-scroll.test.tsx。
 */
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { streamStore } from "@/hooks/use-stream-store";
import { StreamingMessage } from "./streaming-message";

const sessionId = "session-streaming-extension";

afterEach(() => {
  streamStore.drop(sessionId);
});

describe("扩展命令的流", () => {
  it("执行期间不显示用户气泡；普通消息的流照常显示（对照）", () => {
    const el = document.createElement("div");
    streamStore.start(sessionId, "/todos", [], { extensionCommand: true });
    const extension = render(<StreamingMessage sessionId={sessionId} scrollContainerRef={{ current: el }} />);
    expect(extension.container.textContent).not.toContain("/todos");
    extension.unmount();

    streamStore.start(sessionId, "普通问题");
    const plain = render(<StreamingMessage sessionId={sessionId} scrollContainerRef={{ current: el }} />);
    expect(plain.container.textContent).toContain("普通问题");
  });
});
