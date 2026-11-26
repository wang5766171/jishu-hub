/**
 * v0.9.8 评审修复轮 R3（R 域 / P1-1）：任务模式的首条消息把任务意图随 `send_message`
 * 带给后端——后端在拉起进程之前建好任务实例（登记先于首条 prompt），会话解析后
 * 改绑成真实会话号。对应 tests/R-R3修复记录.md 的 R3-1-FE1 / FE3。
 */
import i18n from "@/i18n";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatInput } from "./chat-input";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));
vi.mock("@/hooks/use-stream-store", () => ({
  streamStore: {
    start: vi.fn(),
    alias: vi.fn(),
    getState: vi.fn(),
    drop: vi.fn(),
    noteProcess: vi.fn(),
    markPromptAccepted: vi.fn(),
  },
  useIsSessionStreaming: vi.fn(() => false),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

/** send_message 的替身应答：新会话的会话号在拉起后解析；任务模式下带登记好的实例。 */
const TASK_INSTANCE = {
  task_id: "task-launch-1",
  project_root: "D:\\p",
  title: "把登录页改成深色",
  skill_id: "jishu-task-runner",
  status: "active",
  task_session_id: null,
};

function textbox() {
  const textarea = document.querySelector("textarea");
  if (!textarea) throw new Error("composer textarea not rendered");
  return textarea as HTMLTextAreaElement;
}

function type(text: string) {
  const ta = textbox();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(ta, text);
  fireEvent.input(ta);
}

function pressEnter() {
  fireEvent.keyDown(textbox(), { key: "Enter", code: "Enter" });
}

const sendCalls = () => invokeCommand.mock.calls.filter(([cmd]) => cmd === "send_message");

/** 与页面 `prepareTaskLaunchMessage` 同语义：新任务的首条消息包装成启动命令，之后原样透传。 */
const wrapFirstAsLaunch = (() => {
  let wrapped = false;
  return (message: string) => {
    if (wrapped) return message;
    wrapped = true;
    return `/jishu-task dev ${message}`;
  };
})();

beforeEach(() => {
  invokeCommand.mockReset();
  invokeCommand.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "session_tool_list") return Promise.resolve([]);
    if (cmd === "skillhub_installed") return Promise.resolve({});
    if (cmd === "pi_package_installed_sources") return Promise.resolve([]);
    if (cmd === "send_message") {
      // 与后端同口径：只有带任务意图的发送，返回值里才有登记好的实例。
      const withTask = Boolean(args?.taskLaunch);
      return Promise.resolve({
        agent_id: "jishu-self",
        session_id: "real-session-1",
        process_id: 7,
        ...(withTask ? { task_instance: TASK_INSTANCE } : {}),
      });
    }
    return Promise.resolve({});
  });
});

describe("ChatInput 任务模式首条消息带任务意图（评审修复轮 R3 / P1-1）", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("R3-1-FE1 首条消息被包装成启动命令：send_message 带 taskLaunch，返回的实例交回页面", async () => {
    const onTaskInstanceBound = vi.fn();
    render(
      <ChatInput
        sessionId={null}
        projectPath="D:\\p"
        agentId="jishu-self"
        prepareMessageForAgent={wrapFirstAsLaunch}
        getTaskLaunchIntent={(goal) => ({
          taskId: null,
          skillId: "jishu-task-runner",
          title: goal,
          noAsk: true,
        })}
        onTaskInstanceBound={onTaskInstanceBound}
      />,
    );

    type("把登录页改成深色");
    pressEnter();

    await waitFor(() => expect(sendCalls()).toHaveLength(1));
    const [, args] = sendCalls()[0] as [string, Record<string, unknown>];
    expect(args.message).toBe("/jishu-task dev 把登录页改成深色");
    // 意图：新任务（任务号为空）、技能、不带命令前缀的纯目标、发消息那一刻的开关。
    expect(args.taskLaunch).toEqual({
      taskId: null,
      skillId: "jishu-task-runner",
      title: "把登录页改成深色",
      noAsk: true,
    });
    await waitFor(() => expect(onTaskInstanceBound).toHaveBeenCalledWith(TASK_INSTANCE));
  });

  it("R3-1-FE1 普通会话的消息（没有被包装）：不带 taskLaunch", async () => {
    const onTaskInstanceBound = vi.fn();
    render(
      <ChatInput
        sessionId="s1"
        projectPath="D:\\p"
        agentId="jishu-self"
        getTaskLaunchIntent={vi.fn(() => ({
          taskId: null,
          skillId: "jishu-task-runner",
          title: "不该出现",
          noAsk: false,
        }))}
        onTaskInstanceBound={onTaskInstanceBound}
      />,
    );

    type("随便聊聊");
    pressEnter();

    await waitFor(() => expect(sendCalls()).toHaveLength(1));
    const [, args] = sendCalls()[0] as [string, Record<string, unknown>];
    expect(args.message).toBe("随便聊聊");
    expect("taskLaunch" in args).toBe(false);
    // 没带意图 → 后端不返回实例 → 没有东西交给页面。
    await waitFor(() => expect(textbox()).not.toBeDisabled());
    expect(onTaskInstanceBound).not.toHaveBeenCalled();
  });

  it("R3-1-FE3 任务登记失败（send_message 被拒）：按发送失败处理——不落任务实例、只发了一次", async () => {
    const onTaskInstanceBound = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeCommand.mockImplementation((cmd: string) => {
      if (cmd === "send_message") {
        return Promise.reject(new Error("任务登记失败：任务实例库打不开"));
      }
      return Promise.resolve({});
    });
    render(
      <ChatInput
        sessionId={null}
        projectPath="D:\\p"
        agentId="jishu-self"
        prepareMessageForAgent={wrapFirstAsLaunch}
        getTaskLaunchIntent={(goal) => ({
          taskId: null,
          skillId: "jishu-task-runner",
          title: goal,
          noAsk: false,
        })}
        onTaskInstanceBound={onTaskInstanceBound}
      />,
    );

    type("把登录页改成深色");
    pressEnter();

    await waitFor(() => expect(sendCalls()).toHaveLength(1));
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(onTaskInstanceBound).not.toHaveBeenCalled();
    // 发送态复位：输入框还能继续用（不是卡在「发送中」）。
    await waitFor(() => expect(textbox()).not.toBeDisabled());
    consoleError.mockRestore();
  });
});
