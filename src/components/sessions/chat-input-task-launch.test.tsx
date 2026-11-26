/**
 * v0.9.8 评审修复轮 R3（R 域 / P1-1）：任务模式的首条消息把任务意图随 `send_message`
 * 带给后端——后端在拉起进程之前建好任务实例（登记先于首条 prompt），会话解析后
 * 改绑成真实会话号。对应 tests/R-R3修复记录.md 的 R3-1-FE1 / FE3。
 */
import i18n from "@/i18n";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { streamStore } from "@/hooks/use-stream-store";

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
      const intent = args?.taskLaunch as Record<string, unknown> | undefined;
      if (intent !== undefined) {
        // 嵌套参数的键名 Tauri 不做驼峰 ↔ 下划线转换——字段对不上后端直接拒绝
        //（收口轮在安装包上实跑：意图传了驼峰字段，后端回「invalid args … missing field skill_id」，
        // 每个新任务的第一条消息都发不出去；这里的替身原先照单全收，所以单测是绿的）。
        for (const key of ["task_id", "skill_id", "title"]) {
          if (!(key in intent)) return Promise.reject(new Error(`invalid args \`taskLaunch\` for command \`send_message\`: missing field \`${key}\``));
        }
      }
      const withTask = Boolean(intent);
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
          task_id: null,
          skill_id: "jishu-task-runner",
          title: goal,
          no_ask: true,
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
    // 键名就是后端 TaskLaunchIntent 的字段名（下划线）：嵌套参数 Tauri 不转换键名。
    expect(args.taskLaunch).toEqual({
      task_id: null,
      skill_id: "jishu-task-runner",
      title: "把登录页改成深色",
      no_ask: true,
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
          task_id: null,
          skill_id: "jishu-task-runner",
          title: "不该出现",
          no_ask: false,
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

  it("R3-1-FE3 任务登记失败（send_message 被拒）：按发送失败处理——不落任务实例、只发了一次；乐观流收掉、原因交给页面", async () => {
    const onTaskInstanceBound = vi.fn();
    const onSendFailed = vi.fn();
    vi.mocked(streamStore.start).mockClear();
    vi.mocked(streamStore.drop).mockClear();
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
          task_id: null,
          skill_id: "jishu-task-runner",
          title: goal,
          no_ask: false,
        })}
        onTaskInstanceBound={onTaskInstanceBound}
        onSendFailed={onSendFailed}
      />,
    );

    type("把登录页改成深色");
    pressEnter();

    await waitFor(() => expect(sendCalls()).toHaveLength(1));
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(onTaskInstanceBound).not.toHaveBeenCalled();
    // 发送没有成立：发送之前刚起的那条乐观流（界面上的「正在赶来」）要收掉——
    // 这次没有回合，永远不会有回合事件来给它收尾；原因交给页面提示用户。
    //（收口轮在安装包上实跑：意图的字段对不上、后端当场拒绝，界面就永远停在「正在赶来」。）
    expect(streamStore.start).toHaveBeenCalledTimes(1);
    expect(streamStore.drop).toHaveBeenCalledTimes(1);
    expect(streamStore.drop).toHaveBeenCalledWith(vi.mocked(streamStore.start).mock.calls[0][0]);
    expect(onSendFailed).toHaveBeenCalledTimes(1);
    expect(String((onSendFailed.mock.calls[0] as unknown[])[0])).toContain("任务实例库打不开");
    // 发送态复位：输入框还能继续用（不是卡在「发送中」）；原文还在输入框里。
    await waitFor(() => expect(textbox()).not.toBeDisabled());
    expect(textbox().value).toBe("把登录页改成深色");
    consoleError.mockRestore();
  });

  it("普通消息的发送调用被当场拒绝：同样收掉乐观流并通知页面（发送成立时不收）", async () => {
    const onSendFailed = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(streamStore.start).mockClear();
    vi.mocked(streamStore.drop).mockClear();
    invokeCommand.mockImplementation((cmd: string) =>
      Promise.reject(new Error(cmd === "send_message" ? "引擎启动失败：端口被占用" : "其它调用不关心")),
    );
    render(<ChatInput sessionId="s1" projectPath="D:\p" agentId="jishu-self" onSendFailed={onSendFailed} />);

    type("你好");
    pressEnter();
    await waitFor(() => expect(sendCalls()).toHaveLength(1));
    await waitFor(() => expect(onSendFailed).toHaveBeenCalledTimes(1));
    expect(streamStore.drop).toHaveBeenCalledTimes(1);
    expect(streamStore.drop).toHaveBeenCalledWith("s1");
    expect(textbox().value).toBe("你好");

    // 对照：发送成立——不收流（流由后面的回合事件收尾）、不提示
    invokeCommand.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "send_message" ? { agent_id: "jishu-self", session_id: "s1", process_id: 7 } : {}),
    );
    vi.mocked(streamStore.drop).mockClear();
    onSendFailed.mockClear();
    pressEnter();
    await waitFor(() => expect(sendCalls()).toHaveLength(2));
    await waitFor(() => expect(textbox()).toHaveValue(""));
    expect(streamStore.drop).not.toHaveBeenCalled();
    expect(onSendFailed).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
