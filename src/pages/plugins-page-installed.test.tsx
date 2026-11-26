/**
 * v0.9.8 评审修复轮 R3（二轮评审 M 域）：插件中心的扩展包页签（页面级）。
 * 评审员没搭起页面级探针（页面要 AgentProvider），这里用真实的 AgentProvider
 * （非 Tauri 环境下它不发起任何调用）把页面渲染出来。
 *
 * P2-1   已装扩展清单第一次就读失败 → 页签级提示。修前提示写在卡片渲染函数里，
 *        清单为空时它根本不被调用，页签落「暂无插件」。
 * P2-2a  「卸载更新 / 还原钉版」进统一出口的重装入口。修前直接调安装命令、
 *        返回值被丢掉：撞名时后端回滚并返回待确认，界面当成功。
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));

const listenMock = vi.hoisted(() => vi.fn<(event: string, handler: (e: unknown) => void) => Promise<() => void>>());
listenMock.mockResolvedValue(() => () => {});
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: Parameters<typeof listenMock>) => listenMock(...args),
}));

import { AgentProvider } from "@/agents";
import { PluginsPage } from "./plugins-page";

/** 后端检出工具撞名时的返回：已回滚、实际没装，等用户决断。 */
const CONFLICT = {
  status: "conflict",
  conflicts: [
    { tool: "web_search", opponent_source: "npm:pi-web-access@0.32.0", opponent_display: "联网搜索", opponent_builtin: true },
  ],
};
/** 内置件的钉版快照：装的是 2.0.0，要还原到 1.0.0。 */
const PINS = [{ source: "npm:pkg-x@1.0.0", package: "pkg-x", version: "1.0.0" }];
const READ_FAIL = "读取引擎配置失败：系统找不到指定的文件 (os error 2)";

/** 后端替身：onCommand 优先；sources="fail" 时已装扩展清单读取报错。 */
function setup(opts: {
  sources?: string[] | "fail";
  pins?: unknown[];
  onCommand?: (cmd: string, args: Record<string, unknown>) => unknown;
}) {
  invokeCommand.mockReset();
  invokeCommand.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    const custom = opts.onCommand?.(cmd, args);
    if (custom !== undefined) return custom instanceof Promise ? custom : Promise.resolve(custom);
    switch (cmd) {
      case "plugin_list":
        return Promise.resolve({ plugins: [], manifest_errors: [] });
      case "mcp_plugin_health":
        return Promise.resolve({ available: false, plugins: [] });
      case "pi_package_installed_sources":
        return opts.sources === "fail" ? Promise.reject(READ_FAIL) : Promise.resolve(opts.sources ?? []);
      case "pi_package_installed_versions":
        return Promise.resolve({});
      case "pi_package_builtin_pins":
        return Promise.resolve(opts.pins ?? []);
      case "skillhub_installed":
        return Promise.resolve({});
      case "piindex_search":
      case "extension_registry_list":
      case "plugin_extension_deps":
      case "plugin_confirm_pending":
        return Promise.resolve([]);
      default:
        return Promise.resolve({});
    }
  });
}

const callsOf = (cmd: string) => invokeCommand.mock.calls.filter(([c]) => c === cmd);

/** 渲染插件中心并切到「扩展包」页签；返回页签按钮（计数跟着变）。 */
const openExtensionTab = async () => {
  render(
    <AgentProvider>
      <PluginsPage />
    </AgentProvider>,
  );
  const tab = (await screen.findAllByText(/^扩展包/))[0] as HTMLElement;
  await act(async () => {
    fireEvent.click(tab);
  });
  return tab;
};

const notice = () => document.querySelector("[data-ext-list-unreadable]") as HTMLElement | null;
const clickRetry = async () => {
  await act(async () => {
    fireEvent.click(within(notice()!).getByRole("button", { name: "重试" }));
  });
};
/** 内置件卡片上的「卸载更新」。 */
const clickRestore = async () => {
  const restore = await screen.findByRole("button", { name: "卸载更新" });
  await act(async () => {
    fireEvent.click(restore);
  });
};

beforeEach(() => {
  listenMock.mockReset();
  listenMock.mockResolvedValue(() => () => {});
  window.localStorage.removeItem("plugins-center-tab");
});

describe("插件中心 · 已装扩展清单读取失败（P2-1）", () => {
  it("P2-1-U1 第一次就读失败：扩展包页签显示读取失败与重试，不显示「暂无插件」", async () => {
    setup({ sources: "fail" });
    await openExtensionTab();
    // 修前：清单为空，卡片渲染函数不被调用，页签落「暂无插件」
    expect(await screen.findByText("已安装的扩展清单读取失败")).toBeTruthy();
    expect(notice()).toBeTruthy();
    expect(screen.queryByText("暂无插件")).toBeNull();
    expect(within(notice()!).getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("P2-1-U2 读不到时页签计数不显示 0；重试成功后显示真实数量", async () => {
    let fail = true;
    setup({
      onCommand: (cmd) =>
        cmd === "pi_package_installed_sources" ? (fail ? Promise.reject(READ_FAIL) : ["npm:pkg-x@1.0.0"]) : undefined,
    });
    const tab = await openExtensionTab();
    await screen.findByText("已安装的扩展清单读取失败");
    // 修前页签计数是 0（读不到当成一个都没装）
    expect(tab.textContent).toBe("扩展包–");
    fail = false;
    await clickRetry();
    await waitFor(() => expect(notice()).toBeNull());
    expect(tab.textContent).toBe("扩展包1");
  });

  it("P2-1-U3 之前读到过、这次读失败：上一次的卡片继续显示并标出失败；重试成功后提示消失", async () => {
    // 修前：提示写在卡片渲染函数里，读失败时它把卡片整个换掉——页签计数还是
    // 上一次的数量，页签里却只剩一句「读取失败」，两者对不上
    let fail = false;
    setup({
      onCommand: (cmd) =>
        cmd === "pi_package_installed_sources" ? (fail ? Promise.reject(READ_FAIL) : ["npm:pkg-x@1.0.0"]) : undefined,
    });
    await openExtensionTab();
    await screen.findByText("pkg-x");
    expect(notice()).toBeNull();
    // 插件变更事件触发刷新，这次读取失败
    fail = true;
    await waitFor(() => expect(listenMock.mock.calls.some(([event]) => event === "plugins-changed")).toBe(true));
    const onChanged = listenMock.mock.calls.find(([event]) => event === "plugins-changed")![1];
    await act(async () => {
      onChanged({});
    });
    await screen.findByText("已安装的扩展清单读取失败");
    expect(screen.getByText("pkg-x")).toBeTruthy();
    expect(screen.queryByText("暂无插件")).toBeNull();
    fail = false;
    await clickRetry();
    await waitFor(() => expect(notice()).toBeNull());
  });
});

describe("插件中心 · 还原钉版走统一出口的重装入口（P2-2a）", () => {
  it("P2-2a-U1 撞名 → 弹确认卡；取消 → 不调确认安装、不报失败", async () => {
    setup({
      sources: ["npm:pkg-x@2.0.0"],
      pins: PINS,
      onCommand: (cmd) => (cmd === "pi_package_install_online" ? CONFLICT : undefined),
    });
    await openExtensionTab();
    await clickRestore();
    // 修前：返回值被丢掉，确认卡不弹、界面当成功
    const title = await screen.findByText("能力重叠：pkg-x");
    const card = title.closest('[role="dialog"]') as HTMLElement;
    expect(within(card).getByRole("button", { name: "停用并安装" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "取消" }));
    });
    await waitFor(() => expect(screen.queryByText("能力重叠：pkg-x")).toBeNull());
    expect(callsOf("pi_package_install_confirmed")).toHaveLength(0);
    expect(screen.queryByText("操作失败")).toBeNull();
  });

  it("P2-2a-U2 撞名 → 确认 → 调确认安装，带安装链信息", async () => {
    setup({
      sources: ["npm:pkg-x@2.0.0"],
      pins: PINS,
      onCommand: (cmd) => {
        if (cmd === "pi_package_install_online") return CONFLICT;
        if (cmd === "pi_package_install_confirmed") return { disabled: [{ opponent_display: "联网搜索" }] };
        return undefined;
      },
    });
    await openExtensionTab();
    await clickRestore();
    const title = await screen.findByText("能力重叠：pkg-x");
    const card = title.closest('[role="dialog"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "停用并安装" }));
    });
    expect(callsOf("pi_package_install_confirmed")).toEqual([
      ["pi_package_install_confirmed", { source: "npm:pkg-x@1.0.0", meta: { via: "manual" } }],
    ]);
  });

  it("P2-2a-U3 还原钉版是「已装的件按指定版本重装」：不被「已装就不装」拦下", async () => {
    setup({
      sources: ["npm:pkg-x@2.0.0"],
      pins: PINS,
      onCommand: (cmd) => (cmd === "pi_package_install_online" ? { status: "installed" } : undefined),
    });
    await openExtensionTab();
    await clickRestore();
    // 朴素修法（直接改调 installRef）：件在已装清单里，安装调用不会发出
    await waitFor(() =>
      expect(callsOf("pi_package_install_online")).toEqual([
        ["pi_package_install_online", { source: "npm:pkg-x@1.0.0", meta: { via: "manual" } }],
      ]),
    );
  });

  it("P2-2a-U4 还原钉版失败 → 弹「操作失败」+ 清洗后的原因", async () => {
    setup({
      sources: ["npm:pkg-x@2.0.0"],
      pins: PINS,
      onCommand: (cmd) => (cmd === "pi_package_install_online" ? Promise.reject("[x] 安装失败（ECONNRESET）") : undefined),
    });
    await openExtensionTab();
    await clickRestore();
    const title = await screen.findByText("操作失败");
    const card = title.closest('[role="dialog"]') as HTMLElement;
    // 修前：弹窗描述是「[x] 安装失败（ECONNRESET）」原文
    expect(card.textContent).toContain("安装失败");
    expect(card.textContent).not.toContain("ECONNRESET");
    expect(card.textContent).not.toContain("[x]");
  });
});

describe("插件中心 · 技能台账读取失败（后端域 R3 转来的配合项）", () => {
  const openSkillTab = async () => {
    render(
      <AgentProvider>
        <PluginsPage />
      </AgentProvider>,
    );
    const tab = (await screen.findAllByText(/^技能/))[0] as HTMLElement;
    await act(async () => {
      fireEvent.click(tab);
    });
    return tab;
  };
  const skillNotice = () => document.querySelector("[data-skill-ledger-unreadable]") as HTMLElement | null;

  it("R3-SK1 后端读不了技能台账：技能页签显示读取失败与重试；读到后提示消失", async () => {
    let fail = true;
    setup({
      onCommand: (cmd) => (cmd === "skillhub_installed" && fail ? Promise.reject("技能台账不是合法 JSON") : undefined),
    });
    await openSkillTab();
    // 修前：调用处 .catch(() => ({})) 把读失败吞成「一个技能都没装」，没有任何提示
    expect(await screen.findByText("已安装技能的清单读取失败")).toBeTruthy();
    expect(skillNotice()).toBeTruthy();
    fail = false;
    await act(async () => {
      fireEvent.click(within(skillNotice()!).getByRole("button", { name: "重试" }));
    });
    await waitFor(() => expect(skillNotice()).toBeNull());
  });

  it("R3-SK2 台账读得到：不出提示", async () => {
    setup({});
    await openSkillTab();
    await waitFor(() => expect(callsOf("skillhub_installed").length).toBeGreaterThan(0));
    expect(skillNotice()).toBeNull();
  });
});
