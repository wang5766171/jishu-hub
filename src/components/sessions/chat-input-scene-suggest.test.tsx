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
  },
  useIsSessionStreaming: () => false,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/lib/dev-log", () => ({
  devLog: vi.fn(),
}));

/** v0.9.8 需求6 夹具：已装载编程场景件（task-plan）+ 未装载件（other）
 * + 非本场景件（office-tool）。建议 = curated ∩ 已装载可注入。 */
const fixtures = () => {
  invokeCommand.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "session_tool_list":
        return Promise.resolve([
          // enabled=会话级挂载选中态：建议对象恰是「装了没挂」（enabled=false）
          { id: "task-plan", display_name: "流程规划", description: "", usage: "", enabled: false, injectable: true, category: "cli" },
          { id: "office-tool", display_name: "办公件", description: "", usage: "", enabled: false, injectable: true, category: "cli" },
          { id: "not-injectable", display_name: "扩展件", description: "", usage: "", enabled: false, injectable: false, category: "cli" },
        ]);
      case "get_onboarding_scenes":
        return Promise.resolve(["programming"]);
      case "get_scene_suggest_dismissed":
        return Promise.resolve(false);
      case "is_default_workspace":
        return Promise.resolve(true);
      case "market_list_curated":
        return Promise.resolve([
          { id: "task-plan", kind: "agent", title: "流程规划", description: "", category: "", scenes: ["programming"], required: false },
          { id: "other", kind: "agent", title: "未装件", description: "", category: "", scenes: ["programming"], required: false },
          { id: "office-tool", kind: "agent", title: "办公件", description: "", category: "", scenes: ["office"], required: false },
          { id: "not-injectable", kind: "agent", title: "扩展件", description: "", category: "", scenes: ["programming"], required: false },
        ]);
      default:
        return Promise.resolve({ agent_id: "codex", session_id: "s1", process_id: 1, ...args });
    }
  });
};

const renderInput = (props = {}) =>
  render(
    <ChatInput
      sessionId={null}
      projectPath={"D:\\JishuProjects"}
      agentId="claude-code"
      showSceneSuggest
      {...props}
    />,
  );

describe("ChatInput scene suggestion bar (v0.9.8 需求6)", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(() => {
    invokeCommand.mockReset();
    fixtures();
  });

  it("U1: renders bar for default-workspace empty session and injects pill on click", async () => {
    renderInput();

    // 建议条出现：场景标题 + 仅「已装载可注入」的编程场景件（流程规划）
    await waitFor(() => {
      expect(screen.getByText("编程场景建议挂载")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "流程规划" })).toBeInTheDocument();
    // 未装载件 / 非本场景件 / 不可注入件不出现
    expect(screen.queryByText("未装件")).not.toBeInTheDocument();
    expect(screen.queryByText("办公件")).not.toBeInTheDocument();
    expect(screen.queryByText("扩展件")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "流程规划" }));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toContain("@[流程规划]");
  });

  it("U2: no bar when dismissed / non-default workspace / no scene record", async () => {
    // a) 已关闭
    invokeCommand.mockImplementation((cmd: string) => {
      if (cmd === "get_scene_suggest_dismissed") return Promise.resolve(true);
      if (cmd === "session_tool_list")
        return Promise.resolve([
          { id: "task-plan", display_name: "流程规划", description: "", usage: "", enabled: true, injectable: true, category: "cli" },
        ]);
      if (cmd === "get_onboarding_scenes") return Promise.resolve(["programming"]);
      if (cmd === "is_default_workspace") return Promise.resolve(true);
      if (cmd === "market_list_curated")
        return Promise.resolve([{ id: "task-plan", title: "流程规划", scenes: ["programming"] }]);
      return Promise.resolve({ agent_id: "codex", session_id: "s1", process_id: 1 });
    });
    const { unmount } = renderInput();
    await waitFor(() =>
      expect(invokeCommand).toHaveBeenCalledWith("get_scene_suggest_dismissed"),
    );
    expect(screen.queryByText("编程场景建议挂载")).not.toBeInTheDocument();
    unmount();

    // b) 非默认空间（is_default_workspace=false）
    invokeCommand.mockReset();
    fixtures();
    invokeCommand.mockImplementation((cmd: string) => {
      if (cmd === "is_default_workspace") return Promise.resolve(false);
      if (cmd === "session_tool_list")
        return Promise.resolve([
          { id: "task-plan", display_name: "流程规划", description: "", usage: "", enabled: true, injectable: true, category: "cli" },
        ]);
      if (cmd === "get_onboarding_scenes") return Promise.resolve(["programming"]);
      if (cmd === "get_scene_suggest_dismissed") return Promise.resolve(false);
      if (cmd === "market_list_curated")
        return Promise.resolve([
          { id: "task-plan", title: "流程规划", scenes: ["programming"] },
        ]);
      return Promise.resolve({ agent_id: "codex", session_id: "s1", process_id: 1 });
    });
    const { unmount: u2 } = renderInput();
    await waitFor(() =>
      expect(invokeCommand).toHaveBeenCalledWith("is_default_workspace", { path: "D:\\JishuProjects" }),
    );
    expect(screen.queryByText("编程场景建议挂载")).not.toBeInTheDocument();
    u2();

    // c) 无场景记录
    invokeCommand.mockReset();
    invokeCommand.mockImplementation((cmd: string) => {
      if (cmd === "get_onboarding_scenes") return Promise.resolve(null);
      if (cmd === "session_tool_list") return Promise.resolve([]);
      return Promise.resolve({ agent_id: "codex", session_id: "s1", process_id: 1 });
    });
    renderInput();
    await waitFor(() =>
      expect(invokeCommand).toHaveBeenCalledWith("get_onboarding_scenes"),
    );
    expect(screen.queryByText("编程场景建议挂载")).not.toBeInTheDocument();
  });

  it("U3: dismiss button persists flag and hides bar immediately", async () => {
    renderInput();
    await waitFor(() => {
      expect(screen.getByText("编程场景建议挂载")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("不再提示"));
    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith("set_scene_suggest_dismissed", { value: true });
    });
    expect(screen.queryByText("编程场景建议挂载")).not.toBeInTheDocument();
  });
});
