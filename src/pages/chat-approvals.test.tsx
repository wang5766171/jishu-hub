/**
 * v0.9.8 需求1：交互提交失败分流回归。
 * - 已过期（陈旧卡）：撤卡不回队（v0.9.6 需求8 F1 既有行为）；
 * - No active ACP session（进程已回收/崩溃）：撤卡 + 答案降级 follow_up
 *   经 send_message 重发——修复「恢复卡片 → 反复提交反复失败」死循环；
 * - 瞬时错误：恢复卡片可重试（既有行为）；
 * - mid_turn 正常：对照组，不触发 send_message。
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { streamStore } from "@/hooks/use-stream-store";
import type { ConversationInteractionSubmission } from "@/types";
import { useChatApprovals } from "./chat-approvals";
import type { PendingChatInteraction } from "./chat-page-utils";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));

const SESSION_ID = "01a1e482-4a85-76e4-8ff7-1688f1c78e27";

function makeInteraction(): PendingChatInteraction {
  return {
    agentId: "jishu-self",
    sessionId: SESSION_ID,
    request: {
      requestId: "req-1",
      prompt: "选哪个方案？",
      options: [
        { optionId: "opt-1", label: "方案一" },
        { optionId: "opt-2", label: "方案二" },
      ],
      allowMultiple: false,
      allowCustomText: true,
      required: true,
    },
  };
}

let hook: ReturnType<typeof useChatApprovals> | null = null;

function Harness() {
  hook = useChatApprovals({
    selectedSession: SESSION_ID,
    handleMessageSent: vi.fn(),
    activeIdRef: { current: "jishu-self" },
    projectPathRef: { current: "D:/workspace/demo" },
  });
  return <div data-testid="pending">{hook.pendingInteractions.length}</div>;
}

const submission: ConversationInteractionSubmission = {
  requestId: "req-1",
  selectedOptionIds: ["opt-1"],
  customText: "",
};

async function submitCatching() {
  let caught: unknown = null;
  // act 体内 rethrow 会跳过退出时的状态 flush——吞掉错误让 act 正常收尾，
  // 状态断言才能读到提交后的渲染结果。
  await act(async () => {
    try {
      await hook!.handleInteractionSubmit(submission);
    } catch (error) {
      caught = error;
    }
  });
  return caught;
}

describe("useChatApprovals interaction submit failure routing", () => {
  beforeEach(() => {
    hook = null;
    invokeCommand.mockReset();
    streamStore.drop(SESSION_ID);
  });

  it("已过期：撤卡不回队，错误上抛", async () => {
    invokeCommand.mockRejectedValueOnce(
      "该交互已过期（回合已结束或会话重启），请重新触发提问",
    );
    render(<Harness />);
    act(() => hook!.setPendingInteractions([makeInteraction()]));

    const caught = await submitCatching();
    expect(String(caught)).toContain("已过期");
    expect(hook!.pendingInteractions).toHaveLength(0);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  it("No active ACP session：撤卡并降级 follow_up 重发答案", async () => {
    invokeCommand
      .mockRejectedValueOnce(`No active ACP session found for ${SESSION_ID}`)
      .mockResolvedValueOnce({ delivery: "mid_turn" });
    render(<Harness />);
    act(() => hook!.setPendingInteractions([makeInteraction()]));

    const caught = await submitCatching();
    expect(caught).toBeNull();
    expect(hook!.pendingInteractions).toHaveLength(0);
    // 第二次调用 = send_message 降级重发，携带答案文本与原会话 id
    expect(invokeCommand).toHaveBeenCalledTimes(2);
    const [command, payload] = invokeCommand.mock.calls[1];
    expect(command).toBe("send_message");
    expect(payload.sessionId).toBe(SESSION_ID);
    expect(payload.message).toContain("方案一");
  });

  it("瞬时错误：恢复卡片可重试，错误上抛", async () => {
    invokeCommand.mockRejectedValueOnce(new Error("提交超时（10 秒无响应），请重试"));
    render(<Harness />);
    act(() => hook!.setPendingInteractions([makeInteraction()]));

    const caught = await submitCatching();
    expect(String(caught)).toContain("提交超时");
    expect(hook!.pendingInteractions).toHaveLength(1);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  it("mid_turn 正常：撤卡，不触发 send_message", async () => {
    invokeCommand.mockResolvedValueOnce({ delivery: "mid_turn" });
    render(<Harness />);
    act(() => hook!.setPendingInteractions([makeInteraction()]));

    const caught = await submitCatching();
    expect(caught).toBeNull();
    expect(hook!.pendingInteractions).toHaveLength(0);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });
});
