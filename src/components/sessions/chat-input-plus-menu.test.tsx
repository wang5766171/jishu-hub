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

/** v0.9.8 需求7 夹具：含两件历史残留件（task-requirements/task-plan，
 * v0.9.7 去阶段化后保留的编程场景推荐件）+ 一件普通 CLI 插件。 */
const sessionTools = [
  {
    id: "task-requirements",
    display_name: "需求讨论",
    description: "复杂/模糊需求先聊清楚",
    usage: "",
    enabled: true,
    injectable: true,
    category: "cli",
  },
  {
    id: "task-plan",
    display_name: "流程规划",
    description: "多步骤任务先拆成执行计划",
    usage: "",
    enabled: true,
    injectable: true,
    category: "cli",
  },
  {
    id: "dev-god",
    display_name: "写后诊断",
    description: "写完代码后体检",
    usage: "",
    enabled: true,
    injectable: true,
    category: "cli",
  },
];

describe("ChatInput + menu aggregation (v0.9.8 需求7)", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  beforeEach(() => {
    invokeCommand.mockReset();
    invokeCommand.mockImplementation((cmd: string) => {
      if (cmd === "session_tool_list") return Promise.resolve(sessionTools);
      return Promise.resolve({
        agent_id: "codex",
        session_id: "session-1",
        process_id: 1,
      });
    });
  });

  const openMenu = async () => {
    render(
      <ChatInput
        sessionId="session-1"
        projectPath={"D:\\project"}
        agentId="claude-code"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    // session_tool_list 异步返回后再断言菜单内容
    await waitFor(() => {
      expect(screen.getByText("写后诊断")).toBeInTheDocument();
    });
  };

  it("U1: filters legacy stage plugins (task-requirements/task-plan) and renders two groups", async () => {
    await openMenu();

    // 残留件入口不出现（入口收敛；能力保留由后端下发，不在本断言范围）
    expect(screen.queryByText("需求讨论")).not.toBeInTheDocument();
    expect(screen.queryByText("流程规划")).not.toBeInTheDocument();

    // 普通 CLI 插件仍平铺可见；两组标题到位（输入素材 / 能力挂载）
    expect(screen.getByText("写后诊断")).toBeInTheDocument();
    expect(screen.getByText("Input Materials")).toBeInTheDocument();
    expect(screen.getByText("Capabilities")).toBeInTheDocument();
    expect(screen.getByText("Attachment")).toBeInTheDocument();
  });

  it("U2: clicking a CLI tool still injects the @[name] token into the composer", async () => {
    await openMenu();

    fireEvent.click(screen.getByText("写后诊断"));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toContain("@[写后诊断]");
  });
});
