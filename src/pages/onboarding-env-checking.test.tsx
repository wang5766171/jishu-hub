import i18n from "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { OnboardingWizard } from "./onboarding-wizard";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));

// 事件模块替身：组件挂载时会监听安装进度事件，测试环境里没有 Tauri 桥，
// 不替身会留下未处理的 Promise 拒绝（污染 vitest 退出码）。
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

/** v0.9.8 需求9-④：检测 IPC 未返回前的「检测中…」中间态——此前 env=null
 * 时 ok 恒 false，未检测先显「未安装」（用户实测 #7 首装「不具备」观感）。 */
describe("引导步骤① 环境检测中间态（需求9-④）", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(() => {
    invokeCommand.mockReset();
  });

  it("U4a: check_environment 未返回——四行全部「检测中…」，无「未安装」", async () => {
    invokeCommand.mockImplementation((cmd: string) => {
      if (cmd === "agent_runtime_status")
        return Promise.resolve({ state: "ready", recorded: "v1", expected: "v1" });
      if (cmd === "check_environment")
        return new Promise(() => {}); // 永不返回——中间态
      return Promise.resolve({});
    });
    render(<OnboardingWizard onComplete={() => {}} />);

    const checkingRows = await screen.findAllByText("检测中…");
    expect(checkingRows.length).toBe(4); // Node/npm/Git/Python
    expect(screen.queryByText(/未安装/)).toBeNull();
    // 下载按钮是「结果态」动作——中间态不出现
    expect(screen.queryByText("下载")).toBeNull();
  });

  it("U4b: 检测返回后显真实结果（缺失项显未安装+下载钮）", async () => {
    invokeCommand.mockImplementation((cmd: string) => {
      if (cmd === "agent_runtime_status")
        return Promise.resolve({ state: "ready", recorded: "v1", expected: "v1" });
      if (cmd === "check_environment")
        return Promise.resolve({
          node_installed: true,
          node_version: "22.19.0",
          npm_installed: true,
          npm_version: "10.9.0",
          git_installed: false,
          python_installed: true,
          python_version: "3.12.0",
          runtimes: [],
        });
      return Promise.resolve({});
    });
    render(<OnboardingWizard onComplete={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/未安装/)).toBeTruthy();
    });
    expect(screen.queryByText("检测中…")).toBeNull();
    expect(screen.getByText("v22.19.0")).toBeTruthy();
    // 缺失项出现下载入口
    expect(screen.getByText("下载")).toBeTruthy();
  });
});
