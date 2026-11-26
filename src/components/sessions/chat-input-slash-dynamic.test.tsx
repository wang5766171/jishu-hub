// v0.9.8 需求7 补充（/ 命令面板）+ 补充轮（2026-11-24 用户裁决：选中只填入
// 输入框，点发送才执行）——面板行为与发送时去向的组件级测试。
import i18n from "@/i18n";
import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  // 评审修复轮 R2：用例里按需要把会话切到流式态（引擎正在输出）。
  useIsSessionStreaming: vi.fn(() => false),
}));

import { streamStore, useIsSessionStreaming } from "@/hooks/use-stream-store";
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

beforeEach(() => {
  invokeCommand.mockReset();
  for (const fn of Object.values(streamStore)) vi.mocked(fn).mockClear();
  vi.mocked(useIsSessionStreaming).mockReset();
  vi.mocked(useIsSessionStreaming).mockReturnValue(false);
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

/** 夹具：hub 内建命令（local，发送时本地执行）+ 引擎的动态命令（三源）。 */
const SLASH = [
  { name: "name", label: "重命名会话", available: true, local: true },
  { name: "compact", label: "压缩上下文", available: true, local: true },
  { name: "subagents-guide", label: "子代理使用指南", available: true },
  { name: "skill:jishu-cli-guide", label: "命令行指南", available: true },
  // 评审修复轮 R2：扩展命令（引擎立即执行）与一条当前不可用的内建命令
  { name: "todos", label: "待办", available: true, source: "extension" as const },
  { name: "tpl-x", label: "模板", available: true, source: "prompt" as const },
  { name: "fork", label: "创建会话分支", available: false, local: true, unavailableHint: "当前会话不支持分支" },
];

const sendCalls = () => invokeCommand.mock.calls.filter(([cmd]) => cmd === "send_message");

function textbox() {
  // 附件的标签也是一个输入框（textbox）——只取输入区的 textarea。
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

  it("S2-U10 任务进行中发送 /compact——去向交给压缩请求入口，输入框自己不发消息", async () => {
    // 评审修复轮 R2（裁决 4）：压缩与普通消息等价处理。立即执行还是进待发送区
    // 由页面的压缩请求入口决定（回合进行中 → 排队），输入框只负责把命令交出去。
    const onSlash = vi.fn();
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={onSlash} isSessionStreaming />);
    type("/compact ");
    pressEnter();
    await waitFor(() => {
      expect(onSlash).toHaveBeenCalledWith("compact", "");
    });
    // 没有走发给智能体的任何通道，也没有开乐观流
    expect(screen.queryByText("/compact")).not.toBeInTheDocument();
    expect(invokeCommand).not.toHaveBeenCalledWith("send_message", expect.anything());
    expect(invokeCommand).not.toHaveBeenCalledWith("steer_chat", expect.anything());
    expect(streamStore.start).not.toHaveBeenCalled();
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

// ── v0.9.8 评审修复轮 R2（S 域）────────────────────────────────────────────

/** 给输入面板拖进一个附件（jsdom 没有 DataTransfer，事件对象上手工挂）。 */
async function attachByDrop(name = "shot.png") {
  const panel = document.querySelector(".border-input") as HTMLElement | null;
  if (!panel) throw new Error("input panel not rendered");
  const event = createEvent.drop(panel);
  Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["x"], name, { type: "image/png" })] } });
  fireEvent(panel, event);
  // 图片附件渲染为缩略图，标签显示在它下方的小输入框里。
  await waitFor(() => expect(screen.getByDisplayValue("图片1")).toBeInTheDocument());
}

function expectStreaming() {
  return vi.mocked(useIsSessionStreaming).mockReturnValue(true);
}

describe("ChatInput 评审修复轮 R2：扩展命令与普通消息的分流", () => {
  it("S1-U7 正在输出时发扩展命令：立即执行，不进待发送区、不开流", async () => {
    expectStreaming();
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={vi.fn()} />);
    type("/todos ");
    pressEnter();
    await waitFor(() => {
      expect(sendCalls()).toHaveLength(1);
    });
    expect(sendCalls()[0][1]).toEqual(
      expect.objectContaining({ agentId: "a", sessionId: "s1", message: "/todos" }),
    );
    expect(streamStore.start).not.toHaveBeenCalled();
    expect(screen.queryByText("/todos")).not.toBeInTheDocument();
    await waitFor(() => expect(textbox().value).toBe(""));
  });

  it("S1-U8 正在输出时发提示模板 / 技能命令 / 普通消息：照常进待发送区", async () => {
    expectStreaming();
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={vi.fn()} />);
    for (const text of ["/skill:jishu-cli-guide 你好", "/tpl-x 你好", "你好"]) {
      type(text);
      pressEnter();
    }
    await waitFor(() => {
      expect(document.body.textContent).toContain("/skill:jishu-cli-guide 你好");
      expect(document.body.textContent).toContain("/tpl-x 你好");
    });
    expect(document.body.textContent).toContain("你好");
    expect(sendCalls()).toHaveLength(0);
    expect(streamStore.start).not.toHaveBeenCalled();
  });

  it("S1-U9 引擎空闲发扩展命令：开乐观流并发送，流带扩展命令标记", async () => {
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={vi.fn()} />);
    type("/todos ");
    pressEnter();
    await waitFor(() => {
      expect(sendCalls()).toHaveLength(1);
    });
    expect(sendCalls()[0][1]).toEqual(expect.objectContaining({ message: "/todos" }));
    expect(streamStore.start).toHaveBeenCalledWith(expect.any(String), "/todos", [], { extensionCommand: true });
  });

  it("S1-U10 扩展命令带附件：只发命令原文，附件留在输入框", async () => {
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={vi.fn()} />);
    await attachByDrop();
    type("/todos ");
    pressEnter();
    await waitFor(() => {
      expect(sendCalls()).toHaveLength(1);
    });
    expect(sendCalls()[0][1]).toEqual(expect.objectContaining({ message: "/todos" }));
    expect(screen.getByDisplayValue("图片1")).toBeInTheDocument();
  });
});

describe("ChatInput 评审修复轮 R2：内建命令的不可用与附件", () => {
  it("S7-U3 不可用的内建命令：不清空、不发送，交给页面提示", async () => {
    const onSlash = vi.fn();
    const onUnavailable = vi.fn();
    render(
      <ChatInput
        sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH}
        onSlashCommand={onSlash} onSlashCommandUnavailable={onUnavailable}
      />,
    );
    type("/fork");
    pressEnter();
    await waitFor(() => {
      expect(onUnavailable).toHaveBeenCalledWith("fork", "当前会话不支持分支");
    });
    expect(onSlash).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(0);
    await waitFor(() => expect(textbox().value).toBe("/fork"));
  });

  it("S8-U1 本地命令带附件：命令执行，附件不丢", async () => {
    const onSlash = vi.fn();
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={onSlash} />);
    await attachByDrop();
    type("/name 新标题");
    pressEnter();
    await waitFor(() => {
      expect(onSlash).toHaveBeenCalledWith("name", "新标题");
    });
    expect(screen.getByDisplayValue("图片1")).toBeInTheDocument();
    expect(sendCalls()).toHaveLength(0);
  });

  it("S8-U2 没有内建命令执行回调：输入不被清空，也不当作消息发出去", async () => {
    render(<ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} />);
    type("/name 新标题");
    pressEnter();
    // 没有任何异步动作可等：直接断言输入仍在、消息没发
    expect(textbox().value).toBe("/name 新标题");
    expect(sendCalls()).toHaveLength(0);
    expect(streamStore.start).not.toHaveBeenCalled();
  });
});
