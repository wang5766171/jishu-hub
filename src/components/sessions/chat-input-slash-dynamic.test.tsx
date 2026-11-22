// v0.9.8 需求7 补充：/ 命令对齐 TUI——动态命令（get_commands）面板行为测试。
import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatInput } from "./chat-input";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));
vi.mock("@/hooks/use-stream-store", () => ({
  streamStore: { start: vi.fn(), alias: vi.fn(), getState: vi.fn(), drop: vi.fn() },
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
    return Promise.resolve({});
  });
});

/** 夹具：可执行子集（name 对齐 pi builtin）+ pi 动态命令（insert 模式）。 */
const SLASH = [
  { name: "name", label: "重命名会话", available: true },
  { name: "compact", label: "压缩上下文", available: true },
  { name: "subagents-guide", label: "子代理使用指南", available: true, mode: "insert" as const },
  { name: "skill:jishu-cli-guide", label: "命令行指南", available: true, mode: "insert" as const },
];

function type(text: string) {
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, text);
  fireEvent.input(ta);
}

describe("ChatInput 斜杠命令面板（需求7 补充：TUI 动态命令）", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("U-S1: 输入 / 出面板——可执行件与 pi 动态件并列；过滤按名/标签", async () => {
    const onSlash = vi.fn();
    render(
      <ChatInput
        sessionId="s1"
        projectPath="D:\\p"
        agentId="a"
        slashCommands={SLASH}
        onSlashCommand={onSlash}
      />,
    );
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

  it("U-S2: 点可执行件（run）——清空输入并回调执行", async () => {
    const onSlash = vi.fn();
    render(
      <ChatInput
        sessionId="s1"
        projectPath="D:\\p"
        agentId="a"
        slashCommands={SLASH}
        onSlashCommand={onSlash}
      />,
    );
    type("/");
    await waitFor(() => screen.getAllByText("/compact"));
    fireEvent.mouseDown(screen.getAllByText("/compact")[0].closest("button")!);
    await waitFor(() => {
      expect(onSlash).toHaveBeenCalledWith("compact");
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("U-S3: 点 pi 动态件（insert）——插入 /name 保留可补参，不回调不清空", async () => {
    const onSlash = vi.fn();
    render(
      <ChatInput
        sessionId="s1"
        projectPath="D:\\p"
        agentId="a"
        slashCommands={SLASH}
        onSlashCommand={onSlash}
      />,
    );
    type("/");
    await waitFor(() => screen.getAllByText("/subagents-guide"));
    fireEvent.mouseDown(screen.getAllByText("/subagents-guide")[0].closest("button")!);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(ta.value).toBe("/subagents-guide ");
    });
    expect(onSlash).not.toHaveBeenCalled();
  });

  it("U-S4: 过滤态点动态件——替换 /filter 为 /name（草稿保留语义）", async () => {
    render(
      <ChatInput sessionId="s1" projectPath="D:\\p" agentId="a" slashCommands={SLASH} onSlashCommand={() => {}} />,
    );
    type("/skill");
    await waitFor(() => screen.getAllByText("/skill:jishu-cli-guide"));
    fireEvent.mouseDown(screen.getAllByText("/skill:jishu-cli-guide")[0].closest("button")!);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => {
      // "/" + "skill"（7 字符）被替换为完整 token，非追加。
      expect(ta.value).toBe("/skill:jishu-cli-guide ");
    });
  });
});
