/**
 * v0.9.8 需求1：交互提交失败分流回归。
 * - 已过期（陈旧卡）：撤卡不回队（v0.9.6 需求8 F1 既有行为）；
 * - No active ACP session（进程已回收/崩溃）：撤卡 + 答案降级 follow_up
 *   经 send_message 重发——修复「恢复卡片 → 反复提交反复失败」死循环；
 * - 瞬时错误：恢复卡片可重试（既有行为）；
 * - mid_turn 正常：对照组，不触发 send_message。
 * - 评审修复轮 R2（契约 C5）：两类永久性失败以稳定前缀开头（
 *   `[interaction_stale]` / `[no_active_session]`），先按前缀判断；前缀不在时
 *   退回原来的文案子串。
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { streamStore } from "@/hooks/use-stream-store";
import type { ConversationInteractionSubmission } from "@/types";
import { classifyInteractionSubmitError, useChatApprovals } from "./chat-approvals";
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

// ── v0.9.8 评审修复轮 R2（契约 C5）：按结构化前缀判断 ─────────────────────

describe("评审修复轮 R2：问答卡提交失败按前缀分类", () => {
  beforeEach(() => {
    hook = null;
    invokeCommand.mockReset();
    streamStore.drop(SESSION_ID);
  });

  it("S4-U1 `[interaction_stale]` 开头（不含「已过期」字样）→ 过期：撤卡不回队、上抛", async () => {
    invokeCommand.mockRejectedValueOnce("[interaction_stale] 该交互已失效，请重新发起提问");
    render(<Harness />);
    act(() => hook!.setPendingInteractions([makeInteraction()]));

    const caught = await submitCatching();
    expect(String(caught)).toContain("[interaction_stale]");
    expect(hook!.pendingInteractions).toHaveLength(0);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  it("S4-U2 `[no_active_session]` 开头（不含英文子串）→ 撤卡并把答案作为新消息重发", async () => {
    invokeCommand
      .mockRejectedValueOnce("[no_active_session] 当前没有活动会话")
      .mockResolvedValueOnce({ delivery: "mid_turn" });
    render(<Harness />);
    act(() => hook!.setPendingInteractions([makeInteraction()]));

    const caught = await submitCatching();
    expect(caught).toBeNull();
    expect(hook!.pendingInteractions).toHaveLength(0);
    expect(invokeCommand.mock.calls[1][0]).toBe("send_message");
    expect(invokeCommand.mock.calls[1][1]).toEqual(expect.objectContaining({ sessionId: SESSION_ID }));
  });

  it("S4-U3 前缀不在开头、也不含旧子串 → 瞬时错误：恢复卡片可重试", async () => {
    invokeCommand.mockRejectedValueOnce("重试时遇到 [interaction_stale] 字样的其它报错");
    render(<Harness />);
    act(() => hook!.setPendingInteractions([makeInteraction()]));

    const caught = await submitCatching();
    expect(caught).not.toBeNull();
    expect(hook!.pendingInteractions).toHaveLength(1);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  it("classifyInteractionSubmitError：纯函数对照表（含被 Error 包装的前缀）", () => {
    expect(classifyInteractionSubmitError("[interaction_stale] x")).toBe("stale");
    expect(classifyInteractionSubmitError(new Error("[interaction_stale] x"))).toBe("stale");
    expect(classifyInteractionSubmitError("该交互已过期（回合已结束或会话重启）")).toBe("stale");
    expect(classifyInteractionSubmitError("[no_active_session] x")).toBe("no_session");
    expect(classifyInteractionSubmitError(new Error("[no_active_session] x"))).toBe("no_session");
    expect(classifyInteractionSubmitError("No active ACP session found for s1")).toBe("no_session");
    expect(classifyInteractionSubmitError("提交超时（10 秒无响应），请重试")).toBe("transient");
    expect(classifyInteractionSubmitError("x [interaction_stale]")).toBe("transient");
    expect(classifyInteractionSubmitError(undefined)).toBe("transient");
  });
});
