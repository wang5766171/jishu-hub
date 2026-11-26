import i18n from "@/i18n";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PluginMarketPanel, formatCount } from "./plugin-market";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));

// v0.9.8 评审修复轮 R1：本文件渲染真实组件，事件模块不 mock 则组件挂载期
// 的 listen 直接抛 unhandled rejection（评审 P2 测试域）。
// R2：留下调用记录——用例可以取出 piindex-updated 的回调自己派发。
const listenMock = vi.hoisted(() => vi.fn<(event: string, handler: (e: unknown) => void) => Promise<() => void>>());
listenMock.mockResolvedValue(() => () => {});
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: Parameters<typeof listenMock>) => listenMock(...args),
}));

// 确认卡用真实组件（不 mock）：撞名确认是否弹出、按钮能不能点，都是用户可见结果。

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

  /** 需求15-F6/F7：全部已装——已装行不可勾、标「已安装」、「安装选中项」
   *  翻终态「全部已安装」且不可点（不再是可点却逐项跳过的模糊态）。
   *  评审修复轮 R2 / M-10：断言可见形态（行文字、勾选框可用性），不再断言样式类名。 */
  it("U3: 全部已装终态——已装行标「已安装」且不可勾，按钮翻「全部已安装」不可点", async () => {
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
        // 二轮评审 R3（P2-4a）：台账替身的形状要合预期——技能台账是对象；修前这里
        // 落到默认分支返回 []，新口径下「形状看不懂 = 读不到」。
        case "skillhub_installed":
          return Promise.resolve({});
        case "pi_package_installed_sources":
          return Promise.resolve([]);
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
    // F6：已装行一眼可辨——行上标「已安装」，勾选框不可操作；页脚没有安装入口。
    const installedRow = [...document.querySelectorAll("[data-bundle-dialog] label")].find((l) =>
      l.textContent?.includes("件乙"),
    ) as HTMLElement;
    expect(installedRow.textContent).toContain("已安装");
    expect((installedRow.querySelector("input[type=checkbox]") as HTMLInputElement).disabled).toBe(true);
    expect(
      [...document.querySelectorAll("[data-bundle-dialog] button")].some((b) => b.textContent?.includes("安装选中项")),
    ).toBe(false);
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
});

/** v0.9.8 评审修复轮 R2：三源已装集（R2-6）、安装结果统一消费（R2-7）、取消语义
 *  （M-3），以及 M-6 / M-8 / M-9 / M-10。断言可见结果：文案、按钮可用性、IPC 调用。 */
describe("评审修复轮 R2：市场已装集、安装结果与取消", () => {
  const CURATED = [
    { id: "item-a", kind: "agent", title: "件甲", description: "d", category: "c", scenes: ["programming"], required: false, tags: ["任务拆解"], stars: 5 },
    { id: "item-b", kind: "agent", title: "件乙", description: "d", category: "c", scenes: ["programming"], required: false, tags: ["流程规划"], stars: 4 },
    { id: "item-c", kind: "agent", title: "件丙", description: "d", category: "c", scenes: [], required: false, tags: ["需求讨论"], stars: 4 },
    { id: "item-d", kind: "agent", title: "件丁", description: "d", category: "c", scenes: [], required: false, tags: ["代码检查"], stars: 4 },
    { id: "item-e", kind: "agent", title: "件戊", description: "d", category: "c", scenes: [], required: false, tags: ["文档编写"], stars: 4 },
    { id: "item-f", kind: "agent", title: "件己", description: "d", category: "c", scenes: [], required: false, tags: ["测试用例"], stars: 4 },
  ];
  const PROFILE = {
    session_id: "s-prev",
    scene: "programming",
    updated_at: 1,
    keywords: ["任务拆解", "流程规划", "需求讨论", "代码检查", "文档编写", "测试用例"],
  };
  /** 后端检出工具撞名时的返回（tag=status）：已回滚、实际没装，等用户决断。 */
  const CONFLICT = {
    status: "conflict",
    conflicts: [
      { tool: "web_search", opponent_source: "npm:pi-web-access@0.32.0", opponent_display: "联网搜索", opponent_builtin: true },
    ],
  };
  const PIINDEX_ENTRY = {
    name: "pkg-x",
    description: "desc",
    npm_package: "pkg-x",
    github_url: null,
    install_command: "pi install npm:pkg-x",
    category: "工具",
    kind_label: "扩展",
    detail_url: null,
    stars: 10,
    weekly_downloads: 12345,
    download_trend: null,
    search_text: "pkg-x",
  };

  type Impl = (cmd: string, args: Record<string, unknown>) => unknown;

  /** 后端替身：impl 优先（返回 undefined 时落到 overrides，再落到默认值）。 */
  const setup = (impl?: Impl, overrides: Record<string, unknown> = {}) => {
    invokeCommand.mockReset();
    invokeCommand.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      const custom = impl?.(cmd, args);
      if (custom !== undefined) return custom instanceof Promise ? custom : Promise.resolve(custom);
      if (cmd in overrides) {
        const v = overrides[cmd];
        return v instanceof Promise ? v : Promise.resolve(v);
      }
      switch (cmd) {
        case "plugin_list":
          return Promise.resolve({ plugins: [] });
        case "market_list_curated":
          return Promise.resolve(CURATED);
        case "market_list_bundles":
          return Promise.resolve([]);
        case "market_install":
        case "skillhub_install":
          return Promise.resolve("installed");
        case "pi_package_install_online":
          return Promise.resolve({ status: "installed" });
        case "skillhub_installed":
          return Promise.resolve({});
        case "pi_package_installed_sources":
        case "pi_package_catalog":
        case "piindex_search":
        case "extension_registry_list":
        case "pi_extension_overrides_list":
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

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  const tabButton = (name: string) =>
    [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
  const dialog = () => document.querySelector("[data-bundle-dialog]");
  const dialogText = () => dialog()?.textContent ?? "";
  const dialogButton = (name: string) =>
    [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes(name));
  const rowOf = (title: string) =>
    [...(dialog()?.querySelectorAll("label") ?? [])].find((l) => l.textContent?.includes(title)) as HTMLLabelElement;
  const checkboxOf = (title: string) =>
    rowOf(title).querySelector("input[type=checkbox]") as HTMLInputElement;
  const openCard = async (kind: string) => {
    const card = await waitFor(() => {
      const el = document.querySelector(`[data-bundle-card="${kind}"]`);
      if (!el) throw new Error(`推荐卡 ${kind} 未渲染`);
      return el as HTMLElement;
    });
    fireEvent.click(card);
    await waitFor(() => expect(dialog()).toBeTruthy());
  };
  const pressEscape = async () => {
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
  };
  const clickInstall = async () => {
    await act(async () => {
      fireEvent.click(dialogButton("安装选中项")!);
    });
  };
  const callsOf = (cmd: string) => invokeCommand.mock.calls.filter(([c]) => c === cmd);
  // ── 二轮评审 R3 用到的定位（卡片 / 行都带稳定的 data 属性，不靠文字找容器） ──
  const installIds = () => callsOf("market_install").map(([, args]) => (args as { pluginId: string }).pluginId);
  const marketCard = (ref: string) => document.querySelector(`[data-market-card="${ref}"]`) as HTMLElement | null;
  const cardButton = (ref: string, name: string) =>
    [...(marketCard(ref)?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes(name));
  /** 页面上所有带「安装」字样的按钮（安装 / 安装选中项）。 */
  const installButtons = () => [...document.querySelectorAll("button")].filter((b) => b.textContent?.includes("安装"));
  const noticeOf = (where: "page" | "dialog") =>
    document.querySelector(`[data-installed-notice="${where}"]`) as HTMLElement | null;
  /** 确认卡（真实组件，portal 挂在 body）：按标题文字找到它所在的对话框。 */
  const confirmCard = async (title: string) => {
    const el = await screen.findByText(title);
    return el.closest('[role="dialog"]') as HTMLElement;
  };

  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(async () => {
    await i18n.changeLanguage("zh");
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => () => {});
  });

  // ── M-1（R2-6）三源已装集 ──────────────────────────────────────────

  it("M1-1 精选页签上打开的套装弹层：已装技能显示已安装、不进安装队列", async () => {
    setup(undefined, {
      market_list_bundles: [{
        id: "b1", scene: "programming", title: "套装", description: "d",
        items: [{ ref: "curated:item-a", required: true }, { ref: "skillhub:slug-c", required: true }],
      }],
      skillhub_installed: { "slug-c": "1.0.0" },
    });
    render(<PluginMarketPanel />);
    await openCard("programming");
    expect(rowOf("slug-c").textContent).toContain("已安装");
    expect(checkboxOf("slug-c").disabled).toBe(true);
    await clickInstall();
    await waitFor(() => expect(dialogText()).toContain("安装完成：成功 1 项、失败 0 项"));
    // 再点安装不会把已装技能重新装一遍（后端对已装技能走「整目录重写」的更新分支）
    expect(callsOf("skillhub_install")).toHaveLength(0);
    expect(callsOf("market_install")).toHaveLength(1);
  });

  it("M1-2 套装弹层：已装扩展显示已安装、不进安装队列", async () => {
    setup(undefined, {
      market_list_bundles: [{
        id: "b1", scene: "programming", title: "套装", description: "d",
        items: [{ ref: "curated:item-a", required: true }, { ref: "pi:npm:pkg-x", required: true }],
      }],
      pi_package_installed_sources: ["npm:pkg-x@1.0.0"],
    });
    render(<PluginMarketPanel />);
    await openCard("programming");
    expect(rowOf("npm:pkg-x").textContent).toContain("已安装");
    expect(checkboxOf("npm:pkg-x").disabled).toBe(true);
    await clickInstall();
    await waitFor(() => expect(dialogText()).toContain("安装完成：成功 1 项、失败 0 项"));
    expect(callsOf("pi_package_install_online")).toHaveLength(0);
  });

  it("M1-3 三源各一件且都已装：按钮是「全部已安装」且不可点", async () => {
    setup(undefined, {
      market_list_bundles: [{
        id: "b1", scene: "programming", title: "套装", description: "d",
        items: [
          { ref: "curated:item-a", required: true },
          { ref: "skillhub:slug-c", required: true },
          { ref: "pi:npm:pkg-x", required: true },
        ],
      }],
      plugin_list: { plugins: [{ id: "item-a" }] },
      skillhub_installed: { "slug-c": "1.0.0" },
      pi_package_installed_sources: ["npm:pkg-x@1.0.0"],
    });
    render(<PluginMarketPanel />);
    await openCard("programming");
    const btn = dialogButton("全部已安装") as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(true);
    expect(dialogButton("安装选中项")).toBeUndefined();
    for (const name of ["件甲", "slug-c", "npm:pkg-x"]) {
      expect(rowOf(name).textContent).toContain("已安装");
    }
  });

  it("M1-4 切到别的页签再回来：已装集跟着刷新", async () => {
    const skills: Record<string, string> = {};
    setup((cmd) => (cmd === "skillhub_installed" ? { ...skills } : undefined), {
      market_list_bundles: [{
        id: "b1", scene: "programming", title: "套装", description: "d",
        items: [{ ref: "curated:item-a", required: true }, { ref: "skillhub:slug-c", required: false }],
      }],
    });
    render(<PluginMarketPanel />);
    await waitFor(() => expect(document.querySelector('[data-bundle-card="programming"]')).toBeTruthy());
    fireEvent.click(tabButton("技能市场"));
    await waitFor(() => expect(callsOf("skillhub_list").length).toBeGreaterThan(0));
    // 期间这件技能被装上（别的入口装的）
    skills["slug-c"] = "1.0.0";
    fireEvent.click(tabButton("精选"));
    await openCard("programming");
    await waitFor(() => expect(rowOf("slug-c").textContent).toContain("已安装"));
  });

  it("M1-5 为你推荐：装完关掉再开，清单不再含刚装的件", async () => {
    const installed = new Set<string>();
    setup((cmd, args) => {
      if (cmd === "plugin_list") return { plugins: [...installed].map((id) => ({ id })) };
      if (cmd === "market_install") {
        installed.add(String(args.pluginId));
        return "installed";
      }
      if (cmd === "task_profile_latest") return PROFILE;
      return undefined;
    });
    render(<PluginMarketPanel />);
    await openCard("dynamic");
    for (const name of ["件甲", "件乙", "件丙", "件己"]) expect(dialogText()).toContain(name);
    // 只装前两件
    for (const name of ["件丙", "件丁", "件戊", "件己"]) fireEvent.click(checkboxOf(name));
    await clickInstall();
    await waitFor(() => expect(dialogText()).toContain("安装完成：成功 2 项、失败 0 项"));
    await pressEscape();
    await waitFor(() => expect(dialog()).toBeNull());
    await openCard("dynamic");
    expect(dialogText()).not.toContain("件甲");
    expect(dialogText()).not.toContain("件乙");
    for (const name of ["件丙", "件丁", "件戊", "件己"]) expect(dialogText()).toContain(name);
  });

  // ── M-2（R2-7）安装结果统一消费 ────────────────────────────────────

  it("M1-11 技能市场单卡安装：执行时已装 → 不再装（不出安装调用）", async () => {
    const skills: Record<string, string> = {};
    setup((cmd) => {
      if (cmd === "skillhub_installed") return { ...skills };
      if (cmd === "skillhub_list") {
        return {
          entries: [{
            slug: "slug-c", name: "技能丙", description: "d", category: "c", downloads: 0, score: 0,
            version: "1.0.0", requires_api_key: false, publisher_verified: false, publisher_name: "p",
          }],
          total: 1, page: 1, page_size: 20,
        };
      }
      return undefined;
    });
    render(<PluginMarketPanel />);
    fireEvent.click(tabButton("技能市场"));
    const install = await screen.findByRole("button", { name: "安装" });
    // 卡片渲染之后，这件技能在别的入口被装上（卡片还停在「未装」）
    skills["slug-c"] = "1.0.0";
    await act(async () => {
      fireEvent.click(install);
    });
    // 安装前的安全确认——点安装
    const title = await screen.findByText("安装技能：技能丙");
    const dialog = title.closest('[role="dialog"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "安装" }));
    });
    // 执行时读台账发现已装：没有发起安装（已装的技能再装一次会把技能目录整目录重写）
    await waitFor(() => expect(document.querySelector('[data-install-guide="skill"]')).toBeTruthy());
    expect(callsOf("skillhub_install")).toHaveLength(0);
  });

  it("M2-1 套装弹层：扩展撞名 → 弹确认卡；取消 → 该件未安装、不算成功", async () => {
    setup((cmd) => (cmd === "pi_package_install_online" ? CONFLICT : undefined), {
      market_list_bundles: [{
        id: "b1", scene: "programming", title: "套装", description: "d",
        items: [{ ref: "pi:npm:pkg-x", required: true }],
      }],
    });
    render(<PluginMarketPanel />);
    await openCard("programming");
    await clickInstall();
    const card = await confirmCard("能力重叠：pkg-x");
    expect(card.textContent).toContain("「联网搜索」（工具 web_search）");
    expect(within(card).getByRole("button", { name: "停用并安装" })).toBeTruthy();
    // 等用户决断期间：行标「需确认」，没有安装入口
    expect(dialogText()).toContain("需确认");
    // 二轮评审 R3（P1-1）：「取消剩余项」只在还有没轮到的行时出现——这一批只有
    // 这一件、它在等确认，没有可取消的剩余项（决断在确认卡上做）
    expect(dialogButton("取消剩余项")).toBeUndefined();
    expect(dialogButton("安装选中项")).toBeUndefined();
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "取消" }));
    });
    await waitFor(() => expect(dialogText()).toContain("安装完成：成功 0 项、失败 0 项、未安装 1 项"));
    expect(callsOf("pi_package_install_confirmed")).toHaveLength(0);
    expect(rowOf("npm:pkg-x").textContent).toContain("未安装");
    // 取消后这件仍是未装：安装入口还在，可以再点
    expect(dialogButton("安装选中项")).toBeTruthy();
  });

  it("M2-2 套装弹层：确认 → 停用对手并安装，该件打勾", async () => {
    setup((cmd) => {
      if (cmd === "pi_package_install_online") return CONFLICT;
      if (cmd === "pi_package_install_confirmed") return { disabled: [{ opponent_display: "联网搜索" }] };
      return undefined;
    }, {
      market_list_bundles: [{
        id: "b1", scene: "programming", title: "套装", description: "d",
        items: [{ ref: "pi:npm:pkg-x", required: true }],
      }],
    });
    render(<PluginMarketPanel />);
    await openCard("programming");
    await clickInstall();
    const card = await confirmCard("能力重叠：pkg-x");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "停用并安装" }));
    });
    await waitFor(() => expect(dialogText()).toContain("安装完成：成功 1 项、失败 0 项"));
    expect(callsOf("pi_package_install_confirmed")).toEqual([["pi_package_install_confirmed", { source: "npm:pkg-x", meta: { via: "market-zone" } }]]);
    expect(rowOf("npm:pkg-x").textContent).not.toContain("未安装");
  });

  it("M2-3 npm 检索兜底卡：撞名 → 弹确认卡；取消 → 不弹装后引导卡", async () => {
    setup((cmd) => {
      if (cmd === "piindex_search") return Promise.reject("在线库不可达");
      if (cmd === "pi_package_search") {
        return [{ name: "pkg-x", version: "1.0.0", description: "d", publisher: "p", date: "2024" }];
      }
      if (cmd === "pi_package_install_online") return CONFLICT;
      return undefined;
    });
    render(<PluginMarketPanel />);
    fireEvent.click(tabButton("扩展生态"));
    const install = await screen.findByRole("button", { name: "安装" });
    await act(async () => {
      fireEvent.click(install);
    });
    const card = await confirmCard("能力重叠：pkg-x");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "取消" }));
    });
    await waitFor(() => expect(screen.queryByText("能力重叠：pkg-x")).toBeNull());
    // 实际没装：不出装后引导卡，也没有走「停用并安装」
    expect(document.querySelector("[data-install-guide]")).toBeNull();
    expect(callsOf("pi_package_install_confirmed")).toHaveLength(0);
  });

  it("M2-4 npm 检索兜底卡：无冲突装成 → 弹装后引导卡", async () => {
    setup((cmd) => {
      if (cmd === "piindex_search") return Promise.reject("在线库不可达");
      if (cmd === "pi_package_search") {
        return [{ name: "pkg-x", version: "1.0.0", description: "d", publisher: "p", date: "2024" }];
      }
      return undefined;
    });
    render(<PluginMarketPanel />);
    fireEvent.click(tabButton("扩展生态"));
    const install = await screen.findByRole("button", { name: "安装" });
    await act(async () => {
      fireEvent.click(install);
    });
    await waitFor(() => expect(document.querySelector('[data-install-guide="extension"]')).toBeTruthy());
    expect(document.querySelector("[data-install-guide]")?.textContent).toContain("pkg-x");
    expect(screen.queryByText("能力重叠：pkg-x")).toBeNull();
  });

  /** 在线库主路径原本就消费冲突结果（需求15 方案 A）。R2 把它收拢到与其余入口
   *  同一个安装出口——这两条守着收拢后行为不变。 */
  it("M2-9 在线库主路径：撞名 → 弹确认卡；取消 → 不弹装后引导卡", async () => {
    setup((cmd) => {
      if (cmd === "piindex_search") return [PIINDEX_ENTRY];
      if (cmd === "pi_package_install_online") return CONFLICT;
      return undefined;
    });
    render(<PluginMarketPanel />);
    fireEvent.click(tabButton("扩展生态"));
    const install = await screen.findByRole("button", { name: "安装" });
    await act(async () => {
      fireEvent.click(install);
    });
    const card = await confirmCard("能力重叠：pkg-x");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "取消" }));
    });
    await waitFor(() => expect(screen.queryByText("能力重叠：pkg-x")).toBeNull());
    expect(document.querySelector("[data-install-guide]")).toBeNull();
    expect(callsOf("pi_package_install_confirmed")).toHaveLength(0);
  });

  it("M2-10 在线库主路径：确认 → 停用对手并安装，引导卡注明停用了谁", async () => {
    setup((cmd) => {
      if (cmd === "piindex_search") return [PIINDEX_ENTRY];
      if (cmd === "pi_package_install_online") return CONFLICT;
      if (cmd === "pi_package_install_confirmed") return { disabled: [{ opponent_display: "联网搜索" }] };
      return undefined;
    });
    render(<PluginMarketPanel />);
    fireEvent.click(tabButton("扩展生态"));
    const install = await screen.findByRole("button", { name: "安装" });
    await act(async () => {
      fireEvent.click(install);
    });
    const card = await confirmCard("能力重叠：pkg-x");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "停用并安装" }));
    });
    expect(callsOf("pi_package_install_confirmed")).toEqual([["pi_package_install_confirmed", { source: "npm:pkg-x", meta: { via: "manual" } }]]);
    await waitFor(() => expect(document.querySelector("[data-install-guide]")).toBeTruthy());
    expect(document.querySelector("[data-install-guide]")?.textContent).toContain("已停用：联网搜索");
  });

  // ── M-3 取消后的三个缺口 ──────────────────────────────────────────

  // ── M-3 取消后的三个缺口 + 二轮评审 R3 P1-1（弹层开合与运行落定解耦）──────
  //
  // 修前（R2 的 M3-2/3）：运行期间弹层关不掉——点「取消剩余项」只作废后面的项，
  // 在途那一件落定前 Esc / 遮罩 / × 都被忽略；后端安装子进程没有期限，网络挂起
  // 时用户被困在模态弹层里。现在：关 = 结束这次使用（剩余项不再发起），在途那
  // 一件任其落定——结果照样落、清单照样刷新；落定后再清。M3-1 / M3-4（hook 层
  // 「取消 ≠ 结束」「运行未落定不接受新一轮」）不变。

  /** 三件必备：甲即装成、乙挂起（在途件）、丙排在后面。 */
  const BUNDLE3 = {
    id: "b1", scene: "programming", title: "套装", description: "d",
    items: [
      { ref: "curated:item-a", required: true },
      { ref: "curated:item-b", required: true },
      { ref: "curated:item-c", required: true },
    ],
  };
  /** 另一个套装（另两件）——「在途件落定前打开别的套装」用。 */
  const BUNDLE_OTHER = {
    id: "b2", scene: "office", title: "套装乙", description: "d2",
    items: [
      { ref: "curated:item-d", required: true },
      { ref: "curated:item-e", required: true },
    ],
  };
  /** 第三个套装：与套装甲共用「件乙」——那一轮里它正是在途的那一件。 */
  const BUNDLE_SHARED = {
    id: "b3", scene: "data", title: "套装丙", description: "d3",
    items: [
      { ref: "curated:item-b", required: true },
      { ref: "curated:item-f", required: true },
    ],
  };
  /** 后端替身：台账反映真实已装；乙的安装挂起到 slow 放行；记下台账被读了几次。 */
  const slowBackend = (
    installed: Set<string>,
    slow: { promise: string | PromiseLike<string> },
    bundles: unknown[] = [BUNDLE3, BUNDLE_OTHER],
  ) => {
    const ledger = { reads: 0 };
    setup((cmd, args) => {
      if (cmd === "plugin_list") {
        ledger.reads += 1;
        return { plugins: [...installed].map((id) => ({ id })) };
      }
      if (cmd === "market_install") {
        const id = String(args.pluginId);
        if (id === "item-b") return Promise.resolve(slow.promise).then((r) => { installed.add(id); return r; });
        installed.add(id);
        return "installed";
      }
      return undefined;
    }, { market_list_bundles: bundles });
    return ledger;
  };

  it("P1-1-U1（原 M3-1/2/3）取消剩余项：没轮到的记未安装；在途件落定前能关弹层，关掉后结果照样落、清单照样刷新", async () => {
    const installed = new Set<string>();
    const slow = deferred<string>();
    const ledger = slowBackend(installed, slow);
    const onChanged = vi.fn();
    render(<PluginMarketPanel onChanged={onChanged} />);
    await openCard("programming");
    await clickInstall();
    // 第二件安装中（它的安装调用已发出、还没返回）
    await waitFor(() => expect(installIds()).toContain("item-b"));
    await act(async () => {
      fireEvent.click(dialogButton("取消剩余项")!);
    });
    // 缺口 1：没轮到的件是「未安装」，不是失败
    expect(rowOf("件丙").textContent).toContain("未安装");
    expect(dialogButton("重试失败项")).toBeUndefined();
    // P1-1：在途件落定前弹层也能关（修前这里弹层仍在）
    const readsBeforeClose = ledger.reads;
    expect(onChanged).not.toHaveBeenCalled();
    await pressEscape();
    await waitFor(() => expect(dialog()).toBeNull());
    // 关 = 结束这次使用：没轮到的件不会再发起
    expect(installIds()).toEqual(["item-a", "item-b"]);
    // 在途件落定：结果照样落（台账里有它）、清单照样刷新
    await act(async () => {
      slow.resolve("installed");
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(ledger.reads).toBeGreaterThan(readsBeforeClose));
    expect([...installed].sort()).toEqual(["item-a", "item-b"]);
    expect(installIds()).toEqual(["item-a", "item-b"]);
    // 再打开：乙已安装；上一轮的结果已清（全新一轮）
    await openCard("programming");
    expect(rowOf("件乙").textContent).toContain("已安装");
    expect(checkboxOf("件乙").disabled).toBe(true);
    expect(dialogText()).not.toContain("安装完成");
  });

  it("P1-1-U2 不点取消直接关弹层：剩余项不再发起，在途件落定后清单照样刷新", async () => {
    const installed = new Set<string>();
    const slow = deferred<string>();
    slowBackend(installed, slow);
    const onChanged = vi.fn();
    render(<PluginMarketPanel onChanged={onChanged} />);
    await openCard("programming");
    await clickInstall();
    await waitFor(() => expect(installIds()).toContain("item-b"));
    await pressEscape();
    await waitFor(() => expect(dialog()).toBeNull());
    await act(async () => {
      slow.resolve("installed");
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    // 丙没有装；乙的结果没丢
    expect(installIds()).toEqual(["item-a", "item-b"]);
    expect([...installed].sort()).toEqual(["item-a", "item-b"]);
    await openCard("programming");
    expect(rowOf("件乙").textContent).toContain("已安装");
    expect(dialogText()).not.toContain("安装完成");
    // 没装的丙还能装
    expect(dialogButton("安装选中项")).toBeTruthy();
  });

  it("P1-1-U3 在途件落定前再打开同一个套装：如实显示进行中、不发起新的安装；落定后结果留在弹层里", async () => {
    const installed = new Set<string>();
    const slow = deferred<string>();
    slowBackend(installed, slow);
    render(<PluginMarketPanel />);
    await openCard("programming");
    await clickInstall();
    await waitFor(() => expect(installIds()).toContain("item-b"));
    await pressEscape();
    await waitFor(() => expect(dialog()).toBeNull());
    await openCard("programming");
    // 乙还在装：行上是进行中；丙已取消：未安装
    expect(rowOf("件乙").getAttribute("data-run-state")).toBe("running");
    expect(rowOf("件丙").textContent).toContain("未安装");
    expect(dialogText()).not.toContain("安装完成");
    // 运行未落定：没有安装入口（M3 的口径不变）
    expect(dialogButton("安装选中项")).toBeUndefined();
    await act(async () => {
      slow.resolve("installed");
    });
    await waitFor(() => expect(dialogText()).toContain("安装完成：成功 2 项、失败 0 项、未安装 1 项"));
    expect(installIds()).toEqual(["item-a", "item-b"]);
    // 落定后弹层开着：结果留给用户看；再点安装只装没装的丙
    expect(dialogButton("安装选中项")).toBeTruthy();
  });

  it("P1-1-U4 在途件落定前打开另一个套装：不显示上一轮的结果、不出安装入口；上一轮落定后能装这一批", async () => {
    const installed = new Set<string>();
    const slow = deferred<string>();
    slowBackend(installed, slow);
    render(<PluginMarketPanel />);
    await openCard("programming");
    await clickInstall();
    await waitFor(() => expect(installIds()).toContain("item-b"));
    await pressEscape();
    await waitFor(() => expect(dialog()).toBeNull());
    await openCard("office");
    expect(dialogText()).toContain("套装乙");
    // 套装甲那轮的行状态与汇总不属于这里
    expect(dialog()!.querySelector("[data-run-state]")).toBeNull();
    expect(dialogText()).not.toContain("安装完成");
    expect(dialog()!.querySelector("[data-bundle-busy-another]")).toBeTruthy();
    expect(dialogButton("安装选中项")).toBeUndefined();
    expect(dialogButton("取消剩余项")).toBeUndefined();
    await act(async () => {
      slow.resolve("installed");
    });
    // 甲那轮落定：套装乙的弹层出现安装入口，仍然没有甲那轮的汇总
    await waitFor(() => expect(dialogButton("安装选中项")).toBeTruthy());
    expect(dialogText()).not.toContain("安装完成");
    await clickInstall();
    await waitFor(() => expect(dialogText()).toContain("安装完成：成功 2 项、失败 0 项"));
    // 丙（关弹层时取消的）没装；装的是套装乙的两件
    expect(installIds()).toEqual(["item-a", "item-b", "item-d", "item-e"]);
  });

  it("P1-1-U5 在途件落定前打开的另一个套装里有同一件：这里的行不带那一轮的状态；落定后它显示已安装、不会被再装", async () => {
    const installed = new Set<string>();
    const slow = deferred<string>();
    slowBackend(installed, slow, [BUNDLE3, BUNDLE_SHARED]);
    render(<PluginMarketPanel />);
    await openCard("programming");
    await clickInstall();
    await waitFor(() => expect(installIds()).toContain("item-b"));
    await pressEscape();
    await waitFor(() => expect(dialog()).toBeNull());
    await openCard("data");
    expect(dialogText()).toContain("套装丙");
    // 件乙在套装甲那一轮里是在途——套装丙的弹层里，它的行不带那一轮的状态
    //（修前会把那一轮的进行中 / 结果显示在这里）
    expect(rowOf("件乙").getAttribute("data-run-state")).toBeNull();
    expect(dialogText()).not.toContain("安装完成");
    // 套装甲那一轮还在途：弹层里说明还有别的安装在装，这一批先不能装
    expect(dialog()!.querySelector("[data-bundle-busy-another]")).toBeTruthy();
    expect(dialogButton("安装选中项")).toBeUndefined();
    await act(async () => {
      slow.resolve("installed");
    });
    // 甲那轮落定、清单刷新：件乙在这里显示已安装；这一批只剩另一件可装
    await waitFor(() => expect(rowOf("件乙").textContent).toContain("已安装"));
    await waitFor(() => expect(dialogButton("安装选中项")).toBeTruthy());
    expect(dialogText()).not.toContain("安装完成");
    await clickInstall();
    await waitFor(() => expect(dialogText()).toContain("安装完成：成功 1 项、失败 0 项"));
    expect(installIds()).toEqual(["item-a", "item-b", "item-f"]);
  });

  it("P1-1-U6 弹层关掉后换了页签：在途件落定时刷新的是当前页签的清单（不是发起安装时的那一份）", async () => {
    const installed = new Set<string>();
    const slow = deferred<string>();
    slowBackend(installed, slow);
    render(<PluginMarketPanel />);
    await openCard("programming");
    await clickInstall();
    await waitFor(() => expect(installIds()).toContain("item-b"));
    await pressEscape();
    await waitFor(() => expect(dialog()).toBeNull());
    // 运行还在途，用户去了技能市场
    fireEvent.click(tabButton("技能市场"));
    await waitFor(() => expect(callsOf("skillhub_list").length).toBeGreaterThan(0));
    const skillLoadsBefore = callsOf("skillhub_list").length;
    await act(async () => {
      slow.resolve("installed");
    });
    // 修前：落定时调的是发起安装时闭包里的 load()（精选页签那一份），当前页签不刷新
    await waitFor(() => expect(callsOf("skillhub_list").length).toBeGreaterThan(skillLoadsBefore));
  });

  // ── 二轮评审 R3 P2-6：台账读不到时的显示 ─────────────────────────────

  /** 台账读取可控的后端替身：ok=false 时 plugin_list 报错（已装态不明）。 */
  const ledgerState = () => {
    const state = { ok: true, pending: false };
    setup((cmd) => {
      if (cmd !== "plugin_list") return undefined;
      if (state.pending) return new Promise(() => {});
      return state.ok ? { plugins: [] } : Promise.reject("台账读不到");
    });
    return state;
  };
  const SKILL_ENTRY = {
    slug: "slug-c", name: "技能丙", description: "d", category: "c", downloads: 0, score: 0,
    version: "1.0.0", requires_api_key: false, publisher_verified: false, publisher_name: "p",
  };
  const expectUnknown = (ref: string) => {
    const el = marketCard(ref);
    expect(el, `${ref} 的卡片应在`).toBeTruthy();
    expect(el!.getAttribute("data-installed-state"), ref).toBe("unknown");
    expect(el!.textContent, ref).toContain("状态未知");
    expect(cardButton(ref, "安装"), ref).toBeUndefined();
    expect(cardButton(ref, "卸载"), ref).toBeUndefined();
  };

  it("P2-6-U1 台账读不到：精选卡片显示「状态未知」、不出安装入口；页顶有提示与重试，恢复后能装", async () => {
    const state = ledgerState();
    state.ok = false;
    render(<PluginMarketPanel />);
    await waitFor(() => expect(noticeOf("page")).toBeTruthy());
    // 修前：读不到按空集算，卡片显示未安装并给出「安装」（点了才被执行器拦下）
    for (const id of ["item-a", "item-b", "item-c"]) expectUnknown(`curated:${id}`);
    expect(installButtons()).toEqual([]);
    expect(noticeOf("page")!.textContent).toContain("暂时无法判断哪些插件已安装");
    // 恢复后点重试：回到能装
    state.ok = true;
    await act(async () => {
      fireEvent.click(within(noticeOf("page")!).getByRole("button", { name: "重试" }));
    });
    await waitFor(() => expect(marketCard("curated:item-a")?.getAttribute("data-installed-state")).toBe("missing"));
    expect(cardButton("curated:item-a", "安装")).toBeTruthy();
    expect(noticeOf("page")).toBeNull();
  });

  it("P2-6-U2 台账读不到：扩展目录卡、在线扩展库卡、技能卡都是「状态未知」、没有安装入口", async () => {
    setup((cmd) => {
      if (cmd === "plugin_list") return Promise.reject("台账读不到");
      if (cmd === "pi_package_catalog") {
        return [{ plugin_id: "pi-lens", name: "写后诊断", version: "1.0.0", description: "d", source: "npm:pi-lens@1.0.0", installed: false }];
      }
      if (cmd === "piindex_search") return [PIINDEX_ENTRY];
      if (cmd === "skillhub_list") return { entries: [SKILL_ENTRY], total: 1, page: 1, page_size: 20 };
      return undefined;
    });
    render(<PluginMarketPanel />);
    fireEvent.click(tabButton("扩展生态"));
    await waitFor(() => expect(marketCard("curated:pi-lens")).toBeTruthy());
    await waitFor(() => expect(marketCard("pi:npm:pkg-x")).toBeTruthy());
    expectUnknown("curated:pi-lens");
    expectUnknown("pi:npm:pkg-x");
    expect(installButtons()).toEqual([]);
    fireEvent.click(tabButton("技能市场"));
    await waitFor(() => expect(marketCard("skillhub:slug-c")).toBeTruthy());
    expectUnknown("skillhub:slug-c");
    expect(installButtons()).toEqual([]);
    expect(noticeOf("page")!.textContent).toContain("暂时无法判断哪些插件已安装");
  });

  it("P2-6-U2（续）台账读不到：npm 兜底卡也是「状态未知」、没有安装入口", async () => {
    setup((cmd) => {
      if (cmd === "plugin_list") return Promise.reject("台账读不到");
      if (cmd === "piindex_search") return Promise.reject("在线库不可达");
      if (cmd === "pi_package_search") {
        return [{ name: "pkg-y", version: "1.0.0", description: "d", publisher: "p", date: "2024" }];
      }
      return undefined;
    });
    render(<PluginMarketPanel />);
    fireEvent.click(tabButton("扩展生态"));
    await waitFor(() => expect(marketCard("pi:npm:pkg-y")).toBeTruthy());
    expectUnknown("pi:npm:pkg-y");
    expect(installButtons()).toEqual([]);
  });

  it("P2-6-U3 台账读不到：套装弹层行显示状态未知、不可勾、没有安装入口；弹层内有提示与重试", async () => {
    const state = { ok: false };
    setup((cmd) => (cmd === "plugin_list" ? (state.ok ? { plugins: [] } : Promise.reject("台账读不到")) : undefined), {
      market_list_bundles: [{
        id: "b1", scene: "programming", title: "套装", description: "d",
        items: [{ ref: "curated:item-a", required: true }, { ref: "curated:item-b", required: false }],
      }],
    });
    render(<PluginMarketPanel />);
    await openCard("programming");
    for (const name of ["件甲", "件乙"]) {
      expect(rowOf(name).textContent).toContain("状态未知");
      const box = checkboxOf(name);
      expect(box.disabled).toBe(true);
      // 不显示成勾着的（修前必备项恒显示为勾）
      expect(box.checked).toBe(false);
    }
    expect(dialogButton("安装选中项")).toBeUndefined();
    expect(dialogButton("全部已安装")).toBeUndefined();
    expect(noticeOf("dialog")!.textContent).toContain("暂时无法判断哪些插件已安装");
    // 恢复后重试：行回到可装
    state.ok = true;
    await act(async () => {
      fireEvent.click(within(noticeOf("dialog")!).getByRole("button", { name: "重试" }));
    });
    await waitFor(() => expect(rowOf("件甲").textContent).not.toContain("状态未知"));
    expect(dialogButton("安装选中项")).toBeTruthy();
    expect(noticeOf("dialog")).toBeNull();
  });

  it("P2-6-U4 首次读取还没回来：不下结论——不出卡片、不出「状态未知」、不出提示", async () => {
    const state = ledgerState();
    state.pending = true;
    render(<PluginMarketPanel />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(marketCard("curated:item-a")).toBeNull();
    expect(document.querySelector("[data-installed-unknown]")).toBeNull();
    expect(noticeOf("page")).toBeNull();
    expect(installButtons()).toEqual([]);
  });

  // ── 二轮评审 R3 P2-2b：精选卡片安装进统一出口 ───────────────────────

  it("P2-2b-U1 精选卡片安装经统一出口：带安装链信息，装完出引导卡", async () => {
    setup();
    render(<PluginMarketPanel />);
    await waitFor(() => expect(cardButton("curated:item-a", "安装")).toBeTruthy());
    await act(async () => {
      fireEvent.click(cardButton("curated:item-a", "安装")!);
    });
    // 修前直接调 market_install：不带 meta
    await waitFor(() =>
      expect(callsOf("market_install")).toEqual([["market_install", { pluginId: "item-a", meta: { via: "manual" } }]]),
    );
    await waitFor(() => expect(document.querySelector("[data-install-guide]")).toBeTruthy());
  });

  it("P2-2b-U2 精选卡片：执行时已装 → 不发安装调用，卡片变已安装", async () => {
    const installed = new Set<string>();
    setup((cmd) => (cmd === "plugin_list" ? { plugins: [...installed].map((id) => ({ id })) } : undefined));
    render(<PluginMarketPanel />);
    await waitFor(() => expect(marketCard("curated:item-a")?.getAttribute("data-installed-state")).toBe("missing"));
    // 卡片渲染之后，这件在别的入口被装上（卡片还停在「未装」）
    installed.add("item-a");
    await act(async () => {
      fireEvent.click(cardButton("curated:item-a", "安装")!);
    });
    await waitFor(() => expect(marketCard("curated:item-a")?.getAttribute("data-installed-state")).toBe("installed"));
    expect(callsOf("market_install")).toHaveLength(0);
  });

  it("P2-2b-U3 精选卡片：执行时台账读不到 → 页顶报错（清洗后的文字），不发安装调用", async () => {
    let readable = true;
    setup((cmd) => (cmd === "plugin_list" ? (readable ? { plugins: [] } : Promise.reject("boom")) : undefined));
    render(<PluginMarketPanel />);
    await waitFor(() => expect(cardButton("curated:item-a", "安装")).toBeTruthy());
    readable = false;
    await act(async () => {
      fireEvent.click(cardButton("curated:item-a", "安装")!);
    });
    // 修前：行上是「Error: 无法读取已安装清单…」
    expect(await screen.findByText("无法读取已安装清单，本次未安装")).toBeTruthy();
    expect(callsOf("market_install")).toHaveLength(0);
  });

  // ── 二轮评审 R3 P2-8：跨界面对同一件并行安装 ─────────────────────────

  it("P2-8-U5 套装弹层与在线扩展库卡片对同一件同时点安装：只装一次，两处都是已装", async () => {
    const installedPi: string[] = [];
    const gate = deferred<{ status: string }>();
    setup((cmd, args) => {
      if (cmd === "pi_package_installed_sources") return [...installedPi];
      if (cmd === "piindex_search") return [PIINDEX_ENTRY];
      if (cmd === "pi_package_install_online") {
        return gate.promise.then((r) => {
          installedPi.push(`npm:${String(args.source).slice("npm:".length)}@1.0.0`);
          return r;
        });
      }
      return undefined;
    }, {
      market_list_bundles: [{
        id: "b1", scene: "programming", title: "套装", description: "d",
        items: [{ ref: "pi:npm:pkg-x", required: true }],
      }],
    });
    render(<PluginMarketPanel />);
    await openCard("programming");
    await clickInstall();
    await waitFor(() => expect(callsOf("pi_package_install_online")).toHaveLength(1));
    // 弹层关掉（那一轮还在途），到扩展生态页签点同一张卡的「安装」
    await pressEscape();
    await waitFor(() => expect(dialog()).toBeNull());
    fireEvent.click(tabButton("扩展生态"));
    await waitFor(() => expect(cardButton("pi:npm:pkg-x", "安装")).toBeTruthy());
    await act(async () => {
      fireEvent.click(cardButton("pi:npm:pkg-x", "安装")!);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    // 修前：这里是第二次安装调用
    expect(callsOf("pi_package_install_online")).toHaveLength(1);
    await act(async () => {
      gate.resolve({ status: "installed" });
    });
    await waitFor(() => expect(marketCard("pi:npm:pkg-x")?.getAttribute("data-installed-state")).toBe("installed"));
    expect(callsOf("pi_package_install_online")).toHaveLength(1);
  });

  // ── 二轮评审 R3 P2-15：失败原因经清洗再上屏 ─────────────────────────

  it("P2-15-U2 市场页顶报错条是清洗后的文字", async () => {
    setup((cmd) => {
      if (cmd === "skillhub_list") return { entries: [SKILL_ENTRY], total: 1, page: 1, page_size: 20 };
      if (cmd === "skillhub_install") return Promise.reject("[x] 下载失败（ECONNRESET）");
      return undefined;
    });
    render(<PluginMarketPanel />);
    fireEvent.click(tabButton("技能市场"));
    const install = await screen.findByRole("button", { name: "安装" });
    await act(async () => {
      fireEvent.click(install);
    });
    // 安装前的安全确认——点安装
    const title = await screen.findByText("安装技能：技能丙");
    const card = title.closest('[role="dialog"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "安装" }));
    });
    // 修前上屏的是「[x] 下载失败（ECONNRESET）」原文
    const banner = await screen.findByText("下载失败", { exact: true });
    expect(banner.textContent).toBe("下载失败");
  });

  it("P2-15-U3 套装弹层行显示清洗后的失败原因", async () => {
    setup(
      (cmd) => (cmd === "pi_package_install_online" ? Promise.reject("[install_failed] 安装失败（npm ERR! network）") : undefined),
      {
        market_list_bundles: [{
          id: "b1", scene: "programming", title: "套装", description: "d",
          items: [{ ref: "pi:npm:pkg-x", required: true }],
        }],
      },
    );
    render(<PluginMarketPanel />);
    await openCard("programming");
    await clickInstall();
    await waitFor(() => expect(dialogText()).toContain("安装完成"));
    const row = rowOf("npm:pkg-x").textContent ?? "";
    expect(row).toContain("安装失败");
    expect(row).not.toContain("install_failed");
    expect(row).not.toContain("npm ERR");
    expect(row).not.toContain("Error");
  });

  // ── M-6 / M-8 / M-9 / M-10 ────────────────────────────────────────

  it("M6-2 计数缩写随界面语言", async () => {
    const t = i18n.t.bind(i18n);
    await i18n.changeLanguage("zh");
    expect(formatCount(12345, t)).toBe("1.2万");
    expect(formatCount(999, t)).toBe("999");
    await i18n.changeLanguage("en");
    expect(formatCount(12345, t)).toBe("12.3K");
    await i18n.changeLanguage("zh");
  });

  it("M8-1 切换界面语言后，推荐卡与弹层描述跟着变", async () => {
    setup(undefined, {
      load_last_project: "enc-project",
      workspace_scene: { scene: "programming", basis: ["代码仓库", "package.json"] },
    });
    render(<PluginMarketPanel />);
    const card = await waitFor(() => {
      const el = document.querySelector('[data-bundle-card="dynamic"]') as HTMLElement | null;
      if (!el) throw new Error("推荐卡未渲染");
      return el;
    });
    expect(card.textContent).toContain("项目特征：代码仓库 / package.json");
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    expect(card.textContent).toContain("Project signals: ");
    expect(card.textContent).not.toContain("项目特征：");
    fireEvent.click(card);
    await waitFor(() => expect(dialog()).toBeTruthy());
    expect(dialogText()).toContain("Based on your project: ");
    expect(dialogText()).not.toContain("根据项目特征：");
    await i18n.changeLanguage("zh");
  });

  it("M9-1 精选页签上点「查看」：切到扩展生态页签并显示新目录", async () => {
    setup((cmd) => (cmd === "piindex_search" ? [PIINDEX_ENTRY] : undefined));
    render(<PluginMarketPanel />);
    const handler = await waitFor(() => {
      const call = listenMock.mock.calls.find(([event]) => event === "piindex-updated");
      if (!call) throw new Error("未订阅 piindex-updated");
      return call[1] as (e: unknown) => void;
    });
    await act(async () => {
      handler({});
    });
    const view = await screen.findByRole("button", { name: "查看" });
    await act(async () => {
      fireEvent.click(view);
    });
    // 在线扩展库的目录卡片出现（扩展生态页签的内容），横幅收起
    await screen.findByText("pkg-x");
    expect(screen.getByText("在线扩展库")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "查看" })).toBeNull();
    expect(callsOf("piindex_search").length).toBeGreaterThan(0);
  });

  it("U9-1 装后引导卡的可见文字不含引擎代号", async () => {
    setup((cmd) => (cmd === "piindex_search" ? [PIINDEX_ENTRY] : undefined));
    render(<PluginMarketPanel />);
    fireEvent.click(tabButton("扩展生态"));
    const install = await screen.findByRole("button", { name: "安装" });
    await act(async () => {
      fireEvent.click(install);
    });
    await waitFor(() => expect(document.querySelector("[data-install-guide]")).toBeTruthy());
    const text = document.querySelector("[data-install-guide]")?.textContent ?? "";
    expect(text).toContain("pkg-x");
    // 卡片上已有类别徽标「扩展」——描述不以类别词开头重复一遍
    expect(text).not.toMatch(/\bpi\b/i);
    // 词典两侧同查（英文界面是同一张卡）
    const zh = (await import("@/i18n/zh.json")).default as { market: Record<string, string> };
    const en = (await import("@/i18n/en.json")).default as { market: Record<string, string> };
    for (const desc of [zh.market.guideExtensionDesc, en.market.guideExtensionDesc]) {
      expect(desc).toBeTruthy();
      expect(desc).not.toMatch(/\bpi\b/i);
    }
    expect(zh.market.guideExtensionDesc.startsWith("扩展")).toBe(false);
  });
});
