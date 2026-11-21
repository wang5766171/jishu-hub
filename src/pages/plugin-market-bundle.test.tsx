import i18n from "@/i18n";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PluginMarketPanel } from "./plugin-market";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirmDialog: () => ({
    confirm: async () => true,
    alert: async () => {},
    dialogNode: null,
  }),
}));

/** v0.9.8 需求5：套装详情弹层——串行安装、单项失败继续、必备锁定、已装跳过。 */
describe("场景套装一键安装（需求5）", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  const BUNDLE = {
    id: "bundle-test",
    scene: "programming",
    title: "测试套装",
    description: "三件：甲失败乙成功丙技能成功",
    items: [
      { ref: "curated:item-a", required: true },
      { ref: "curated:item-b", required: false },
      { ref: "skillhub:slug-c", required: false },
    ],
  };

  const setup = (opts?: { failFirst?: boolean }) => {
    invokeCommand.mockReset();
    invokeCommand.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      switch (cmd) {
        case "plugin_list":
          return Promise.resolve({ plugins: [] });
        case "market_list_curated":
          return Promise.resolve([
            { id: "item-a", kind: "agent", title: "件甲", description: "d", category: "c", scenes: [], required: false },
            { id: "item-b", kind: "agent", title: "件乙", description: "d", category: "c", scenes: [], required: false },
          ]);
        case "market_list_bundles":
          return Promise.resolve([BUNDLE]);
        case "market_install":
          // 首轮：item-a 拒绝、item-b 成功；重试轮（retryPhase=true）全成功
          if (args.pluginId === "item-a" && !(globalThis as Record<string, unknown>).__retryPhase) {
            return Promise.reject("模拟失败：网络不可达");
          }
          return Promise.resolve("installed");
        case "skillhub_install":
          return Promise.resolve("installed");
        case "skillhub_installed":
          return Promise.resolve({});
        case "pi_package_catalog":
        case "pi_package_installed_sources":
        case "piindex_search":
          return Promise.resolve([]);
        case "skillhub_list":
          return Promise.resolve({ skills: [], total: 0 });
        // 需求5（合并版）挂载期新增命令：配置默认开、标签库空、无画像。
        case "equip_config_get":
          return Promise.resolve({
            enabled: true, session_card: true, session_limit: 1,
            input_bar: true, market_zone: true, third_party: true,
          });
        case "equipment_tags_list":
          return Promise.resolve([]);
        case "task_profile_latest":
          return Promise.resolve(null);
        default:
          return Promise.resolve({});
      }
    });
    void opts;
  };

  const openBundleDialog = async () => {
    render(<PluginMarketPanel onChanged={() => {}} />);
    const card = await waitFor(() => {
      const el = [...document.querySelectorAll("[data-bundle-card]")][0] as HTMLElement | undefined;
      if (!el) throw new Error("bundle card not rendered yet");
      return el;
    });
    fireEvent.click(card);
    await waitFor(() => {
      expect(document.querySelector("[data-bundle-dialog]")).toBeTruthy();
    });
  };

  it("U1: 串行安装——单项失败继续、汇总可重试", async () => {
    setup();
    await openBundleDialog();

    // 三项全选（required item-a 锁定；勾选 b、c）
    const checkboxes = [...document.querySelectorAll("[data-bundle-dialog] input[type=checkbox]")];
    expect(checkboxes.length).toBe(3);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(checkboxes[2]);

    // 点安装选中项
    const installBtn = [...document.querySelectorAll("[data-bundle-dialog] button")].find((b) =>
      b.textContent?.includes("安装选中项"),
    )!;
    expect(installBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(installBtn);
    });

    // 汇总：成功 2（item-b + skillhub）失败 1（item-a）
    await waitFor(() => {
      expect(document.body.textContent).toContain("成功 2 项、失败 1 项");
    });
    expect(invokeCommand).toHaveBeenCalledWith("market_install", {
      pluginId: "item-a",
      meta: { via: "market-zone" },
    });
    expect(invokeCommand).toHaveBeenCalledWith("market_install", {
      pluginId: "item-b",
      meta: { via: "market-zone" },
    });
    expect(invokeCommand).toHaveBeenCalledWith("skillhub_install", {
      slug: "slug-c",
      meta: { via: "market-zone" },
    });

    // 失败项重试（mock 转成功）→ 五修②：重试保历史（先前 ✓ 不清屏）——
    // 汇总=全量 3 件成功（旧口径会清成「成功 1 项」）。
    (globalThis as Record<string, unknown>).__retryPhase = true;
    const retryBtn = [...document.querySelectorAll("[data-bundle-dialog] button")].find((b) =>
      b.textContent?.includes("重试失败项"),
    )!;
    expect(retryBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(retryBtn);
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("成功 3 项、失败 0 项");
    });
  });

  it("U2: 必备项锁定勾选；已装项禁用且不进安装队列", async () => {
    setup();
    // 预置 item-b 已安装（plugin_list 含 item-b）
    invokeCommand.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "plugin_list") return Promise.resolve({ plugins: [{ id: "item-b", enabled: true }] });
      void args;
      if (cmd === "market_install") return Promise.resolve("installed");
      if (cmd === "market_list_bundles") return Promise.resolve([BUNDLE]);
      if (cmd === "market_list_curated")
        return Promise.resolve([
          { id: "item-a", kind: "agent", title: "件甲", description: "d", category: "c", scenes: [], required: false },
          { id: "item-b", kind: "agent", title: "件乙", description: "d", category: "c", scenes: [], required: false },
        ]);
      if (cmd === "skillhub_list") return Promise.resolve({ skills: [], total: 0 });
      if (cmd === "skillhub_installed") return Promise.resolve({});
      if (cmd === "equip_config_get")
        return Promise.resolve({
          enabled: true, session_card: true, session_limit: 1,
          input_bar: true, market_zone: true, third_party: true,
        });
      if (cmd === "equipment_tags_list") return Promise.resolve([]);
      if (cmd === "task_profile_latest") return Promise.resolve(null);
      return Promise.resolve(cmd === "piindex_search" || cmd === "pi_package_catalog" ? [] : {});
    });
    await openBundleDialog();

    const boxes = [...document.querySelectorAll("[data-bundle-dialog] input[type=checkbox]")];
    // item-a（required）锁定勾选；item-b（已装）禁用
    expect((boxes[0] as HTMLInputElement).disabled).toBe(true);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).disabled).toBe(true);
    expect(document.body.textContent).toContain("已安装");

    // 安装只发起 item-a（b 已装跳过；c 未勾不进队列）
    const installBtn = [...document.querySelectorAll("[data-bundle-dialog] button")].find((b) =>
      b.textContent?.includes("安装选中项"),
    )!;
    await act(async () => {
      fireEvent.click(installBtn);
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("成功 1 项、失败 0 项");
    });
    expect(invokeCommand).toHaveBeenCalledWith("market_install", {
      pluginId: "item-a",
      meta: { via: "market-zone" },
    });
    expect(invokeCommand).not.toHaveBeenCalledWith("market_install", {
      pluginId: "item-b",
      meta: { via: "market-zone" },
    });
  });

  /** 需求15-F6/F7：全部已装——已装行灰化（opacity）、「安装选中项」
   *  翻终态「全部已安装」且不可点（不再是可点却逐项跳过的模糊态）。
   *  夹具用纯 curated 两件（skillhub 已装态只在技能页签加载，精选页签
   *  恒为未装——不掺 skillhub 件以免终态不成立）。 */
  it("U3: 全部已装终态——行灰化 + 按钮翻「全部已安装」置灰", async () => {
    const BUNDLE_ALL_INSTALLED = {
      id: "bundle-all-installed",
      scene: "programming",
      title: "全装套装",
      description: "两件均已装",
      items: [
        { ref: "curated:item-a", required: true },
        { ref: "curated:item-b", required: false },
      ],
    };
    invokeCommand.mockReset();
    invokeCommand.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "plugin_list":
          // item-a/item-b 均已装
          return Promise.resolve({ plugins: [{ id: "item-a", enabled: true }, { id: "item-b", enabled: true }] });
        case "market_list_bundles":
          return Promise.resolve([BUNDLE_ALL_INSTALLED]);
        case "market_list_curated":
          return Promise.resolve([
            { id: "item-a", kind: "agent", title: "件甲", description: "d", category: "c", scenes: [], required: false },
            { id: "item-b", kind: "agent", title: "件乙", description: "d", category: "c", scenes: [], required: false },
          ]);
        default:
          return Promise.resolve([]);
      }
    });
    await openBundleDialog();

    const btn = [...document.querySelectorAll("[data-bundle-dialog] button")].find((b) =>
      b.textContent?.includes("全部已安装"),
    )!;
    expect(btn).toBeTruthy();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    // F6：已装行灰化（与不可用项同款 opacity-55）
    const installedRow = [...document.querySelectorAll("[data-bundle-dialog] label")].find((l) =>
      l.textContent?.includes("件乙"),
    ) as HTMLElement;
    expect(installedRow.className).toContain("opacity-55");
  });
});
