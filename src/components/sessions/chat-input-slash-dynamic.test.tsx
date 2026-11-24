// v0.9.8 需求7 补充（/ 命令面板）+ 补充轮（2026-11-24 用户裁决：选中只填入
// 输入框，点发送才执行）——面板行为与发送时去向的组件级测试。
import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  useIsSessionStreaming: () => false,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

beforeEach(() => {
  invokeCommand.mockReset();
  invokeCommand.mockImplementation((cmd: string) => {
    if (cmd === "session_tool_list") return Promise.resolve([]);
    if (cmd === "equip_config_get")
      return Promise.resolve({ enabled: true, session_card: true, session_limit: 1, input_bar: true, market_zone: true, third_party: true });
    if (cmd === "equipment_tags_list") return Promise.resolve([]);
    if (cmd === "task_profile_latest") return Promise.resolve(null);
    if (cmd === "plugin_list") return Promise.resolve({ plugins: [] });
    if (cmd === "skillhub_installed") return Promise.resolve({});
    if (cmd === "pi_package_installed_sources") return Promise.resolve([]);
    if (cmd === "get_scene_suggest_dismissed") return Promise.resolve(false);
    if (cmd === "workspace_scene") return Promise.resolve(null);
    if (cmd === "send_message") return Promise.resolve({ session_id: "s1", process_id: 7 });
    return Promise.resolve({});
  });
});

/** 夹具：hub 内建命令（local，发送时本地执行）+ pi 动态命令（发送给智能体）。 */
const SLASH = [
  { name: "name", label: "重命名会话", available: true, local: true },
  { name: "compact", label: "压缩上下文", available: true, local: true },
  { name: "subagents-guide", label: "子代理使用指南", available: true },
  { name: "skill:jishu-cli-guide", label: "命令行指南", available: true },
];

const sendCalls = () => invokeCommand.mock.calls.filter(([cmd]) => cmd === "send_message");

function textbox() {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
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

describe("ChatInput 斜杠命令面板（需求7 补充 + 补充轮）", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("U-S1 输入 / 出面板——hub 内建命令与 pi 动态命令并列；过滤按名/标签", async () => {
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={vi.fn()} />);
    type("/");
    await waitFor(() => {
      expect(screen.getAllByText("/name").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("/compact").length).toBeGreaterThan(0);
    expect(screen.getAllByText("/subagents-guide").length).toBeGreaterThan(0);
    expect(screen.getAllByText("/skill:jishu-cli-guide").length).toBeGreaterThan(0);

    // 过滤：输入 /sub → 只剩 subagents-guide。
    type("/sub");
    await waitFor(() => {
      expect(screen.queryByText("/name")).not.toBeInTheDocument();
      expect(screen.getAllByText("/subagents-guide").length).toBeGreaterThan(0);
    });
  });

  it("UC-1 鼠标点选内建命令（compact）——只填入输入框，不执行", async () => {
    const onSlash = vi.fn();
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={onSlash} />);
    type("/");
    await waitFor(() => screen.getAllByText("/compact"));
    fireEvent.mouseDown(screen.getAllByText("/compact")[0].closest("button")!);
    await waitFor(() => {
      expect(textbox().value).toBe("/compact ");
    });
    expect(onSlash).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(0);
  });

  it("UC-2 键盘选中内建命令（/comp + Enter）——只填入输入框，不执行", async () => {
    const onSlash = vi.fn();
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={onSlash} />);
    type("/comp");
    await waitFor(() => screen.getAllByText("/compact"));
    pressEnter();
    await waitFor(() => {
      expect(textbox().value).toBe("/compact ");
    });
    expect(onSlash).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(0);
  });

  it("UC-3 再按一次 Enter 发送 /compact——此时才执行，且不发给智能体", async () => {
    const onSlash = vi.fn();
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={onSlash} />);
    type("/compact");
    await waitFor(() => screen.getAllByText("/compact"));
    pressEnter(); // 面板开着：这一下是「选中」
    expect(onSlash).not.toHaveBeenCalled();
    pressEnter(); // 面板已关：这一下是「发送」
    await waitFor(() => {
      expect(onSlash).toHaveBeenCalledWith("compact", "");
    });
    await waitFor(() => {
      expect(textbox().value).toBe("");
    });
    expect(sendCalls()).toHaveLength(0);
  });

  it("UC-4 任务进行中发送 /compact——立即执行，不进暂存区（与「立即压缩」按钮一致）", async () => {
    const onSlash = vi.fn();
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={onSlash} isSessionStreaming />);
    type("/compact ");
    pressEnter();
    await waitFor(() => {
      expect(onSlash).toHaveBeenCalledWith("compact", "");
    });
    // 没有变成暂存条目，也没有走发给智能体的任何通道
    expect(screen.queryByText("/compact")).not.toBeInTheDocument();
    expect(invokeCommand).not.toHaveBeenCalledWith("send_message", expect.anything());
    expect(invokeCommand).not.toHaveBeenCalledWith("steer_chat", expect.anything());
  });

  it("UC-5 /compact 带补充要求——补充要求原样交给执行器", async () => {
    const onSlash = vi.fn();
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={onSlash} />);
    type("/compact 只保留接口设计");
    pressEnter();
    await waitFor(() => {
      expect(onSlash).toHaveBeenCalledWith("compact", "只保留接口设计");
    });
    expect(sendCalls()).toHaveLength(0);
  });

  it("UC-7 pi 动态命令、普通消息、不是命令的斜杠文本——照常发给智能体", async () => {
    const onSlash = vi.fn();
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={onSlash} />);
    type("/skill:jishu-cli-guide 怎么安装插件");
    pressEnter();
    await waitFor(() => {
      expect(sendCalls().length).toBe(1);
    });
    expect(sendCalls()[0][1]).toEqual(expect.objectContaining({ message: expect.stringContaining("/skill:jishu-cli-guide 怎么安装插件") }));

    type("帮我看看这个报错");
    pressEnter();
    type("/unknown-command 文本");
    pressEnter();
    await waitFor(() => {
      expect(sendCalls().length).toBe(3);
    });
    expect(sendCalls()[1][1]).toEqual(expect.objectContaining({ message: "帮我看看这个报错" }));
    expect(sendCalls()[2][1]).toEqual(expect.objectContaining({ message: "/unknown-command 文本" }));
    expect(onSlash).not.toHaveBeenCalled();
  });

  it("U-S3 点 pi 动态命令——插入 /name 保留可补参，不执行不清空", async () => {
    const onSlash = vi.fn();
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={onSlash} />);
    type("/");
    await waitFor(() => screen.getAllByText("/subagents-guide"));
    fireEvent.mouseDown(screen.getAllByText("/subagents-guide")[0].closest("button")!);
    await waitFor(() => {
      expect(textbox().value).toBe("/subagents-guide ");
    });
    expect(onSlash).not.toHaveBeenCalled();
  });

  it("U-S4 过滤态点动态命令——替换 /filter 为 /name（草稿保留语义）", async () => {
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={vi.fn()} />);
    type("/skill");
    await waitFor(() => screen.getAllByText("/skill:jishu-cli-guide"));
    fireEvent.mouseDown(screen.getAllByText("/skill:jishu-cli-guide")[0].closest("button")!);
    await waitFor(() => {
      // "/" + "skill"（7 字符）被替换为完整 token，非追加。
      expect(textbox().value).toBe("/skill:jishu-cli-guide ");
    });
  });
});
