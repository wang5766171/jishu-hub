import i18n from "@/i18n";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PluginMarketPanel } from "./plugin-market";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));

// v0.9.8 评审修复轮 R1：本文件渲染真实组件，事件模块不 mock 则组件挂载期
// 的 listen 直接抛 unhandled rejection（评审 P2 测试域）。
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
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
      // 评审修复轮 R1：mock 形状补齐（返回值须可迭代，同真实命令）。
      if (cmd === "pi_package_installed_sources") return Promise.resolve([]);
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

/** v0.9.8 评审修复轮 R1：推荐文案（R1-6）、套装弹层重开（R1-7）、引导卡文案（R1-8）。 */
describe("评审修复轮 R1：市场推荐与套装弹层", () => {
  const curatedProgramming = [
    { id: "item-a", kind: "agent", title: "件甲", description: "d", category: "c", scenes: ["programming"], required: false },
    { id: "item-b", kind: "agent", title: "件乙", description: "d", category: "c", scenes: ["programming"], required: false },
  ];
  const BUNDLE_A = {
    id: "bundle-a", scene: "programming", title: "套装甲", description: "甲",
    items: [{ ref: "curated:item-a", required: true }],
  };
  const BUNDLE_B = {
    id: "bundle-b", scene: "office", title: "套装乙", description: "乙",
    items: [{ ref: "curated:item-b", required: true }],
  };

  const setup = (overrides: Record<string, unknown>) => {
    invokeCommand.mockReset();
    invokeCommand.mockImplementation((cmd: string) => {
      if (cmd in overrides) return Promise.resolve(overrides[cmd]);
      switch (cmd) {
        case "plugin_list":
          return Promise.resolve({ plugins: [] });
        case "market_list_curated":
          return Promise.resolve(curatedProgramming);
        case "market_list_bundles":
          return Promise.resolve([BUNDLE_A, BUNDLE_B]);
        case "market_install":
          return Promise.resolve("installed");
        case "skillhub_installed":
          return Promise.resolve({});
        case "pi_package_catalog":
        case "pi_package_installed_sources":
        case "piindex_search":
          return Promise.resolve([]);
        case "skillhub_list":
          return Promise.resolve({ skills: [], total: 0 });
        case "equip_config_get":
          return Promise.resolve({
            enabled: true, session_card: true, session_limit: 1,
            input_bar: true, market_zone: true, third_party: true,
          });
        case "equipment_tags_list":
          return Promise.resolve([]);
        case "task_profile_latest":
          return Promise.resolve(null);
        case "load_last_project":
          return Promise.resolve(null);
        default:
          return Promise.resolve({});
      }
    });
  };

  const dialogButtons = () =>
    [...document.querySelectorAll("[data-bundle-dialog] button")].map((b) => b.textContent ?? "");
  const dialogText = () => document.querySelector("[data-bundle-dialog]")?.textContent ?? "";

  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("U7-1 项目特征命中：推荐卡与弹层描述是实际特征文字，不露占位符、不套「根据最近任务」", async () => {
    setup({
      load_last_project: "enc-project",
      workspace_scene: { scene: "programming", basis: ["代码仓库", "package.json"] },
    });
    render(<PluginMarketPanel onChanged={() => {}} />);
    const card = await waitFor(() => {
      const el = document.querySelector('[data-bundle-card="dynamic"]') as HTMLElement | null;
      if (!el) throw new Error("推荐卡未渲染");
      return el;
    });
    expect(card.textContent).toContain("项目特征：代码仓库 / package.json");
    expect(card.textContent).not.toContain("{basis}");

    fireEvent.click(card);
    await waitFor(() => {
      expect(document.querySelector("[data-bundle-dialog]")).toBeTruthy();
    });
    const dialogText = document.querySelector("[data-bundle-dialog]")!.textContent ?? "";
    expect(dialogText).toContain("根据项目特征：代码仓库 / package.json");
    expect(dialogText).not.toContain("根据最近任务");
    expect(dialogText).not.toContain("{basis}");
  });

  it("U8-1 套装装完关掉再开另一个：是全新一轮——有安装入口，不停在上次汇总", async () => {
    setup({});
    render(<PluginMarketPanel onChanged={() => {}} />);
    await waitFor(() => {
      expect(document.querySelectorAll("[data-bundle-card]").length).toBe(2);
    });
    const cards = [...document.querySelectorAll("[data-bundle-card]")];
    fireEvent.click(cards[0]);
    await waitFor(() => {
      expect(document.querySelector("[data-bundle-dialog]")?.textContent).toContain("套装甲");
    });
    const installBtn = [...document.querySelectorAll("[data-bundle-dialog] button")].find((b) =>
      b.textContent?.includes("安装选中项"),
    )!;
    expect(installBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(installBtn);
    });
    await waitFor(() => {
      expect(dialogText()).toContain("安装完成：成功 1 项");
    });

    // 关闭弹层（运行已结束）。
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await waitFor(() => {
      expect(document.querySelector("[data-bundle-dialog]")).toBeNull();
    });

    // 再打开另一个套装。
    fireEvent.click([...document.querySelectorAll("[data-bundle-card]")][1]);
    await waitFor(() => {
      expect(document.querySelector("[data-bundle-dialog]")?.textContent).toContain("套装乙");
    });
    expect(dialogButtons().some((t) => t.includes("安装选中项"))).toBe(true);
    expect(dialogText()).not.toContain("安装完成");
    expect(dialogText()).not.toContain("重试失败项");
  });

  it("U9-1 装后引导卡文案不含引擎代号", async () => {
    const zh = (await import("@/i18n/zh.json")).default as { market: Record<string, string> };
    const en = (await import("@/i18n/en.json")).default as { market: Record<string, string> };
    for (const desc of [zh.market.guideExtensionDesc, en.market.guideExtensionDesc]) {
      expect(desc).toBeTruthy();
      expect(desc).not.toMatch(/\bpi\b/i);
    }
    // 卡片上已有类别徽标「扩展」（guideKindExtension）——描述不再以类别词开头重复一遍
    expect(zh.market.guideExtensionDesc.startsWith("扩展")).toBe(false);
  });
});
