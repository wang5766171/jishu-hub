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

/** 需求5（合并版）夹具：装备建议条 = 任务信号驱动（L1 画像 → L0 草稿 →
 * 官方入门回落）+ 未装件浮卡安装 + 已装未挂件 @[注入]。静态场景三守卫
 * （默认空间/首启场景字段）已随旧需求6 设计退役。 */
const DEFAULT_CONFIG = {
  enabled: true,
  session_card: true,
  session_limit: 1,
  input_bar: true,
  market_zone: true,
  third_party: true,
};

const fixtures = (opts?: { dismissed?: boolean; profile?: { scene: string; keywords: string[] } | null }) => {
  invokeCommand.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "session_tool_list":
        return Promise.resolve([
          // enabled=会话级挂载选中态：建议对象恰是「装了没挂」（enabled=false）
          { id: "task-plan", display_name: "流程规划", description: "", usage: "", enabled: false, injectable: true, category: "cli" },
          { id: "not-injectable", display_name: "扩展件", description: "", usage: "", enabled: false, injectable: false, category: "cli" },
          // 需求5 优化轮：用户自装技能（category=skill，不在 curated——
          // 此前被 curated 交集挡在挂载建议外）。
          { id: "pmaster", display_name: "产品经理综合技能", description: "", usage: "", enabled: false, injectable: true, category: "skill" },
        ]);
      case "get_scene_suggest_dismissed":
        return Promise.resolve(opts?.dismissed ?? false);
      case "equip_config_get":
        return Promise.resolve(DEFAULT_CONFIG);
      case "equipment_tags_list":
        return Promise.resolve([]);
      case "task_profile_latest":
        return Promise.resolve(opts?.profile === undefined ? { session_id: "s-prev", scene: "video", keywords: ["视频生成", "配音"], updated_at: 1 } : opts.profile);
      case "plugin_list":
        return Promise.resolve({ plugins: [] });
      case "skillhub_installed":
        return Promise.resolve({});
      case "pi_package_installed_sources":
        return Promise.resolve([]);
      case "market_list_curated":
        return Promise.resolve([
          { id: "task-plan", kind: "agent", title: "流程规划", description: "", category: "", scenes: ["programming"], required: false, tags: ["任务拆解"], stars: 5 },
          { id: "session.video-maker", kind: "composed", title: "视频生成助手", description: "视频流水线", category: "", scenes: ["video"], required: false, tags: ["视频生成", "分镜"], stars: 5 },
          { id: "session.tts-helper", kind: "composed", title: "配音助手", description: "生成旁白音频", category: "", scenes: ["video"], required: false, tags: ["配音"], stars: 3 },
          { id: "pi-lens", kind: "pi-package", title: "写后诊断", description: "", category: "", scenes: ["programming"], required: false, tags: ["代码检查"], stars: 4 },
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

describe("ChatInput 装备建议条（v0.9.8 需求5 合并版）", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(() => {
    invokeCommand.mockReset();
  });

  it("U1: L1 画像驱动——未装件浮卡推荐 + 已装未挂件注入", async () => {
    fixtures();
    renderInput();

    // 建议条出现：按最近任务（画像 video）→ 未装推荐=视频生成助手（tags 命中）
    await waitFor(() => {
      expect(screen.getByText("推荐插件")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /视频生成助手/ })).toBeInTheDocument();
    // 已装可挂载件在条上——含用户自装技能（pmaster，不在 curated 也进——
    // 需求5 优化轮扩源）与 curated 件（流程规划）。
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "流程规划" })).toBeInTheDocument();
    });
    await waitFor(() => {
      const skill = screen.getByRole("button", { name: /产品经理综合技能/ });
      expect(skill.getAttribute("title")).toBe("点击使用");
    });
    // 画像未命中的件不出现
    expect(screen.queryByText("写后诊断")).not.toBeInTheDocument();

    // 已装未挂件点击 → @[注入]
    fireEvent.click(screen.getByRole("button", { name: "流程规划" }));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toContain("@[流程规划]");
  });

  it("U1b: 未装件点击出浮卡 → 安装（via=input-bar）", async () => {
    fixtures();
    renderInput();
    await waitFor(() => {
      expect(screen.getByText("推荐插件")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /视频生成助手/ }));
    await waitFor(() => {
      expect(document.querySelector("[data-equip-popover]")).toBeTruthy();
    });
    const installBtn = [...document.querySelectorAll("[data-equip-popover] button")].find((b) =>
      b.textContent?.includes("安装"),
    )!;
    expect(installBtn).toBeTruthy();
    fireEvent.click(installBtn);
    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith("market_install", {
        pluginId: "session.video-maker",
        meta: { via: "input-bar", title: "视频生成助手" },
      });
    });
    // 装成后浮卡关闭、该件从建议条摘除
    await waitFor(() => {
      expect(document.querySelector("[data-equip-popover]")).toBeFalsy();
    });
    expect(screen.queryByRole("button", { name: /视频生成助手/ })).not.toBeInTheDocument();
  });

  it("U2: 已关闭 / 配置关（总开关·input_bar 链路）不出现", async () => {
    // a) 用户点过 ×
    fixtures({ dismissed: true });
    const { unmount } = renderInput();
    await waitFor(() =>
      expect(invokeCommand).toHaveBeenCalledWith("get_scene_suggest_dismissed"),
    );
    expect(screen.queryByText("推荐插件")).not.toBeInTheDocument();
    unmount();

    // b) input_bar 链路开关关
    invokeCommand.mockReset();
    fixtures();
    const originalImpl = invokeCommand.getMockImplementation()!;
    invokeCommand.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "equip_config_get")
        return Promise.resolve({ ...DEFAULT_CONFIG, input_bar: false });
      return originalImpl(cmd, args);
    });
    renderInput();
    await waitFor(() =>
      expect(invokeCommand).toHaveBeenCalledWith("equip_config_get"),
    );
    expect(screen.queryByText("推荐插件")).not.toBeInTheDocument();
  });

  it("U3: 点 × 持久化关闭标志并立即隐藏", async () => {
    fixtures();
    renderInput();
    await waitFor(() => {
      expect(screen.getByText("推荐插件")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("不再提示"));
    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith("set_scene_suggest_dismissed", { value: true });
    });
    expect(screen.queryByText("推荐插件")).not.toBeInTheDocument();
  });

  it("U4: 无画像无命中 → 官方入门回落（stars 排序）", async () => {
    fixtures({ profile: null });
    renderInput();
    await waitFor(() => {
      expect(screen.getByText("推荐插件")).toBeInTheDocument();
    });
    // 入门回落取未装 curated 件（stars 排序 top3）
    expect(screen.getAllByRole("button", { name: /视频生成助手|流程规划|写后诊断|配音助手/ }).length).toBeGreaterThan(0);
  });
});
