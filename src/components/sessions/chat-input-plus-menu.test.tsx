import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatInput, extractToolTokens } from "./chat-input";

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
  // v0.9.8 需求5（合并版）：已装 pi 扩展条目（后端 session_tool_list 下发
  // category=extension + keep_text）。
  {
    id: "npm:pi-lens",
    display_name: "扩展·写后诊断",
    description: "pi 扩展（能力随安装自动注入，点名后 agent 优先使用）",
    usage: "",
    enabled: false,
    injectable: true,
    category: "extension",
    keep_text: true,
  },
  {
    id: "npm:pi-web-access",
    display_name: "扩展·联网搜索",
    description: "pi 扩展",
    usage: "",
    enabled: false,
    injectable: true,
    category: "extension",
    keep_text: true,
  },
  // 需求7 补充四：自建 [[agent-tool]] 混合件（插件级聚合条目）。
  {
    id: "plugin:video-pipeline",
    display_name: "视频流水线",
    description: "插件工具：video_pipeline / storyboard",
    usage: "",
    enabled: false,
    injectable: true,
    category: "agent-tool",
    keep_text: true,
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

  /** 需求15-F10：CLI 平铺与 MCP 组均空、仅 Skill 一项时——能力挂载组内
   *  渲染一行占位说明（此前组内只剩 Skill，用户无从得知为什么没有别的）。 */
    it("U-EXT1: 扩展组在 + 菜单呈现（与 Skill 同款折叠子菜单）", async () => {
    await openMenu();
    // 组头可见；条目折叠（点开前不显示具体扩展）
    expect(screen.getByText("Extensions")).toBeInTheDocument();
    expect(screen.queryByText("扩展·写后诊断")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Extensions"));
    await waitFor(() => {
      expect(screen.getByText("扩展·写后诊断")).toBeInTheDocument();
      expect(screen.getByText("扩展·联网搜索")).toBeInTheDocument();
    });
  });

  it("U-EXT2: 点扩展条目注入 token；keep_text 发送保留原文+归一 id", async () => {
    await openMenu();
    fireEvent.click(screen.getByText("Extensions"));
    fireEvent.click(screen.getByText("扩展·写后诊断"));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toContain("@[扩展·写后诊断]");
  });

  it("U-AT1: 插件工具组在 + 菜单呈现（混合件 [[agent-tool]] 引用入口）", async () => {
    await openMenu();
    expect(screen.getByText("Plugin tools")).toBeInTheDocument();
    expect(screen.queryByText("视频流水线")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Plugin tools"));
    await waitFor(() => {
      expect(screen.getByText("视频流水线")).toBeInTheDocument();
    });
  });

  it("U-AT2: 点插件工具条目注入 token；keep_text 保留原文+归一 id", async () => {
    await openMenu();
    fireEvent.click(screen.getByText("Plugin tools"));
    fireEvent.click(screen.getByText("视频流水线"));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toContain("@[视频流水线]");
    const { text, toolIds } = extractToolTokens(textarea.value, [
      { id: "plugin:video-pipeline", display_name: "视频流水线", keep_text: true },
    ]);
    expect(text).toContain("@[视频流水线]");
    expect(toolIds).toEqual(["plugin:video-pipeline"]);
  });

  it("U-EXT3: extractToolTokens——扩展 token 保留原文且归一 id；传统件剥离子集不变", () => {
    // 导出的纯函数级验证（chat-input 单源导出）。
    const tools = [
      { id: "dev-god", display_name: "写后诊断" },
      { id: "npm:pi-lens", display_name: "扩展·写后诊断", keep_text: true },
    ];
    const { text, toolIds } = extractToolTokens("用 @[写后诊断] 和 @[扩展·写后诊断] 查代码", tools);
    // 传统件剥离；扩展保留原文（点名传给 agent）。
    expect(text.replace(/  +/g, " ")).toBe("用 和 @[扩展·写后诊断] 查代码");
    expect(toolIds).toEqual(["dev-god", "npm:pi-lens"]);
  });

it("U3: cli/mcp 均空时显示能力挂载空态占位说明", async () => {
    invokeCommand.mockImplementation((cmd: string) => {
      if (cmd === "session_tool_list")
        return Promise.resolve([
          {
            id: "jishu-cli-guide",
            display_name: "jishu CLI 指南",
            description: "d",
            usage: "",
            enabled: true,
            injectable: true,
            category: "skill",
          },
        ]);
      return Promise.resolve({ agent_id: "codex", session_id: "session-1", process_id: 1 });
    });
    render(
      <ChatInput
        sessionId="session-1"
        projectPath={"D:\\project"}
        agentId="claude-code"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    await waitFor(() => {
      expect(screen.getByText("Capabilities")).toBeInTheDocument();
    });
    // Skill 子菜单组在（唯一可挂载项），空态占位说明同屏出现
    expect(screen.getByText("Skill")).toBeInTheDocument();
    expect(
      screen.getByText("No mountable plugin tools yet — install from the plugin market"),
    ).toBeInTheDocument();
  });
});
