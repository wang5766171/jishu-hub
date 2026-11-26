/**
 * v0.9.8 评审修复轮 R3（二轮评审 P1-2）：新手引导的安装步走统一出口、选择步读已装集。
 *
 * 修前：④ 直接调 skillhub_install / market_install——后端对已装技能的「安装」是整目录
 * 删了重写，用户放在技能目录里的改动会没掉；③ 选了场景就把各场景前几个技能默认勾上，
 * 不看已装。装过之后再回管理页重走引导，默认勾选里的技能会被再装一遍。
 * 现在：安装步经 installRef（执行时已装 → 行直接是「已安装」，不发安装调用）；选择步
 * 读同一份已装集，已装的标出来、不默认勾上；读不到已装集时不默认勾选并说明原因。
 *
 * 向导的步骤间传递用的是模块级 holder（向导不重挂载），跨用例会留着——各用例的件
 * 用各自的 id，互不串。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { OnboardingWizard } from "./onboarding-wizard";

interface Curated {
  id: string;
  title: string;
  /** 不给 = 不属于任何场景（只在全量清单里出现，如套装项）。 */
  scene?: string;
}

/** 后端替身：环境全就绪；已装集由 installed 给出（ledger 优先，用来改成报错或动态值）。 */
function setup(opts: {
  plugins?: Curated[];
  bundles?: Array<{ id: string; scene: string; title: string; description: string; items: Array<{ ref: string; required: boolean }> }>;
  skills?: string[];
  installed?: { plugins?: string[]; skills?: string[] };
  ledger?: () => unknown;
  onInstall?: (cmd: string, args: Record<string, unknown>) => unknown;
}) {
  invokeCommand.mockReset();
  invokeCommand.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "agent_runtime_status":
        return Promise.resolve({ state: "ready", recorded: "v1", expected: "v1" });
      case "check_environment":
        return Promise.resolve({
          node_installed: true, node_version: "22.19.0",
          npm_installed: true, npm_version: "10.9.0",
          git_installed: true, git_version: "2.47.0",
          python_installed: false, python_version: null,
          runtimes: [],
        });
      case "market_list_curated": {
        const scene = args.scene as string | null;
        return Promise.resolve(
          (opts.plugins ?? [])
            .filter((p) => !scene || p.scene === scene)
            .map((p) => ({ id: p.id, title: p.title, description: "d", scenes: p.scene ? [p.scene] : [], required: false })),
        );
      }
      case "market_list_bundles":
        return Promise.resolve(opts.bundles ?? []);
      case "plugin_list":
        return opts.ledger
          ? Promise.resolve(opts.ledger())
          : Promise.resolve({ plugins: (opts.installed?.plugins ?? []).map((id) => ({ id })) });
      case "skillhub_installed":
        return Promise.resolve(Object.fromEntries((opts.installed?.skills ?? []).map((s) => [s, "1.0.0"])));
      case "pi_package_installed_sources":
        return Promise.resolve([]);
      case "skillhub_list": {
        const entries = (opts.skills ?? []).map((slug) => ({
          slug, name: `技能-${slug}`, description: "d", version: "1.0.0",
          requires_api_key: false, publisher_verified: false,
        }));
        return Promise.resolve({ entries, total: entries.length, page: 1, page_size: 4 });
      }
      case "market_install":
      case "skillhub_install": {
        const custom = opts.onInstall?.(cmd, args);
        if (custom !== undefined) return custom instanceof Promise ? custom : Promise.resolve(custom);
        return Promise.resolve("installed");
      }
      default:
        return Promise.resolve({});
    }
  });
}

const callsOf = (cmd: string) => invokeCommand.mock.calls.filter(([c]) => c === cmd);

const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const next = () => click(screen.getByText("下一步"));

/** 从头走到第③步：环境就绪 → 选「编程」场景 → 下一步。
 *  同一条用例里可以走两遍（第二次 = 应用没重启时重走引导）：先卸掉上一个向导。 */
const toRecommendStep = async () => {
  cleanup();
  render(<OnboardingWizard onComplete={() => {}} />);
  const proceed = await screen.findByRole("button", { name: "下一步" });
  await waitFor(() => expect(proceed).toBeEnabled());
  await click(proceed);
  await click(await screen.findByText("编程"));
  await next();
  await screen.findByText("按需配齐插件");
};

/** 第③ / ④步里的一行（标题 → 它所在的 label）。 */
const row = (title: string) => screen.getByText(title).closest("label") as HTMLElement;
const boxOf = (title: string) => row(title).querySelector("input[type=checkbox]") as HTMLInputElement;
/** 等④装完：「开始使用」可点。 */
const installSettled = async () => {
  const start = screen.getByRole("button", { name: "开始使用" });
  await waitFor(() => expect(start).toBeEnabled());
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("新手引导 · 已装的件不重装、不默认勾（P1-2）", () => {
  it("P1-2-U1 重走引导：已装的技能标「已安装」、不默认勾上、不进安装清单；装成的行打勾", async () => {
    setup({ skills: ["sa-installed", "sa-fresh"], installed: { skills: ["sa-installed"] } });
    await toRecommendStep();
    // 修前：两件都默认勾上（选了场景就勾各场景前 4 个技能，不看已装）
    await waitFor(() => expect(row("技能-sa-installed").textContent).toContain("已安装"));
    expect(boxOf("技能-sa-installed").checked).toBe(false);
    expect(boxOf("技能-sa-installed").disabled).toBe(true);
    expect(boxOf("技能-sa-fresh").checked).toBe(true);
    await next();
    await installSettled();
    // 已装的技能没有再装一遍（后端对已装技能的「安装」是整目录删了重写）
    expect(callsOf("skillhub_install")).toEqual([["skillhub_install", { slug: "sa-fresh", meta: { via: "manual" } }]]);
    expect(row("技能-sa-fresh").getAttribute("data-row-state")).toBe("done");
  });

  it("P1-2-U2 重走引导：已装的插件（含套装必备项）标已安装、不进安装清单", async () => {
    setup({
      plugins: [{ id: "pb2-a", title: "件二甲" }, { id: "pb2-b", title: "件二乙", scene: "programming" }],
      bundles: [{
        id: "b2", scene: "programming", title: "入门二", description: "d",
        items: [{ ref: "curated:pb2-a", required: true }],
      }],
      installed: { plugins: ["pb2-a", "pb2-b"] },
    });
    await toRecommendStep();
    await waitFor(() => expect(row("件二甲").textContent).toContain("已安装"));
    // 套装必备项：修前锁定为勾；已装 → 不勾、不可点
    expect(boxOf("件二甲").checked).toBe(false);
    expect(boxOf("件二甲").disabled).toBe(true);
    expect(row("件二乙").textContent).toContain("已安装");
    expect(boxOf("件二乙").checked).toBe(false);
    await next();
    await screen.findByText("没有勾选任何项——直接开始使用");
    expect(callsOf("market_install")).toHaveLength(0);
  });

  it("P1-2-U3 安装步执行时才发现已装：不发安装调用，行直接是「已安装」", async () => {
    let installedNow: string[] = [];
    setup({
      plugins: [{ id: "pc3", title: "件三", scene: "programming" }],
      ledger: () => ({ plugins: installedNow.map((id) => ({ id })) }),
    });
    await toRecommendStep();
    await waitFor(() => expect(boxOf("件三").checked).toBe(true));
    // ③ 渲染之后，这件在别的入口被装上
    installedNow = ["pc3"];
    await next();
    await installSettled();
    expect(callsOf("market_install")).toHaveLength(0);
    expect(row("件三").getAttribute("data-row-state")).toBe("already");
    expect(row("件三").textContent).toContain("已安装");
  });

  it("P1-2-U4 已装清单读不到：不默认勾选任何项并说明原因；手动勾的件到④仍读不到则不装、给出原因", async () => {
    setup({
      bundles: [{
        id: "b4", scene: "programming", title: "入门四", description: "d",
        items: [{ ref: "curated:pd4-a", required: true }],
      }],
      plugins: [{ id: "pd4-a", title: "件四甲" }, { id: "pd4-b", title: "件四乙", scene: "programming" }],
      ledger: () => Promise.reject("台账读不到"),
    });
    await toRecommendStep();
    await screen.findByText("暂时无法判断哪些已经安装，没有默认勾选；已安装的不会重复安装");
    // 修前：选了场景就默认勾（含套装必备项）
    for (const title of ["件四甲", "件四乙"]) {
      expect(boxOf(title).checked, title).toBe(false);
      expect(boxOf(title).disabled, title).toBe(false);
    }
    // 用户自己勾一件 → ④：执行时仍读不到 → 不装、行上给原因
    await click(boxOf("件四乙"));
    await next();
    await installSettled();
    expect(callsOf("market_install")).toHaveLength(0);
    expect(row("件四乙").getAttribute("data-row-state")).toBe("failed");
    expect(row("件四乙").textContent).toContain("无法读取已安装清单，本次未安装");
  });

  it("P1-2-U5 安装失败时行上给出原因（清洗后的文字）", async () => {
    setup({
      plugins: [{ id: "pe5", title: "件五", scene: "programming" }],
      onInstall: (cmd) => (cmd === "market_install" ? Promise.reject("[install_failed] 下载失败（ECONNRESET）") : undefined),
    });
    await toRecommendStep();
    await waitFor(() => expect(boxOf("件五").checked).toBe(true));
    await next();
    await installSettled();
    const text = row("件五").textContent ?? "";
    expect(row("件五").getAttribute("data-row-state")).toBe("failed");
    expect(text).toContain("下载失败");
    expect(text).not.toContain("install_failed");
    expect(text).not.toContain("ECONNRESET");
    expect(text).not.toContain("Error");
  });
});

describe("新手引导 · 默认勾选按设计生效（P1-2 实施中查出的现状缺陷）", () => {
  const UNKNOWN_NOTE = "暂时无法判断哪些已经安装，没有默认勾选；已安装的不会重复安装";
  const note = () => document.querySelector("[data-onboarding-installed-unknown]") as HTMLElement | null;

  it("P1-2-U6 选了场景：未装的推荐项默认勾上（插件与技能都是）", async () => {
    setup({ plugins: [{ id: "pf6", title: "件六", scene: "programming" }], skills: ["sf6"] });
    await toRecommendStep();
    // 修前：默认勾选的判定写在 setState 的更新函数里，React 求值时这一项已被记成
    // 「已见」，判定恒为假——一件都不会默认勾上（收版反馈⑤的设计没生效）
    await waitFor(() => expect(boxOf("件六").checked).toBe(true));
    expect(boxOf("技能-sf6").checked).toBe(true);
  });

  it("P1-2-U7 读不到时一件不默认勾并给出原因；点重试读到之后，未装的默认勾上、已装的标出不勾", async () => {
    let readable = false;
    setup({
      plugins: [
        { id: "pg7-a", title: "件七甲", scene: "programming" },
        { id: "pg7-b", title: "件七乙", scene: "programming" },
      ],
      ledger: () => (readable ? { plugins: [{ id: "pg7-a" }] } : Promise.reject("台账读不到")),
    });
    await toRecommendStep();
    await screen.findByText(UNKNOWN_NOTE);
    expect(boxOf("件七甲").checked).toBe(false);
    expect(boxOf("件七乙").checked).toBe(false);
    readable = true;
    await click(within(note()!).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(note()).toBeNull());
    await waitFor(() => expect(boxOf("件七乙").checked).toBe(true));
    // 已装的那件：标出来、不勾、不可点
    expect(row("件七甲").textContent).toContain("已安装");
    expect(boxOf("件七甲").checked).toBe(false);
    expect(boxOf("件七甲").disabled).toBe(true);
  });

  it("P1-2-U8 取消勾选后返回再进来：不会被重新默认勾上（已见的项不回加）", async () => {
    setup({ plugins: [{ id: "ph8", title: "件八", scene: "programming" }] });
    await toRecommendStep();
    await waitFor(() => expect(boxOf("件八").checked).toBe(true));
    // 用户取消勾选，回到上一步再进来
    await click(boxOf("件八"));
    expect(boxOf("件八").checked).toBe(false);
    await click(screen.getByText("上一步"));
    // 场景步重挂载后选择是空的——重新选同一个场景再进下一步
    await click(screen.getByText("编程"));
    await next();
    await screen.findByText("按需配齐插件");
    await waitFor(() => expect(row("件八")).toBeTruthy());
    expect(boxOf("件八").checked).toBe(false);
  });

  it("P1-2-U9 同一次运行里第二次走引导：上一次取消勾选的件保持不勾（不重新默认勾）；上一次装上的标已安装", async () => {
    // 向导的步骤间传递是模块级 holder，应用不重启就一直在——「只对首次出现的新项默认勾」
    // 跨两次引导也成立。发版说明里「未装的会默认勾上」因此要按「第一次见到」理解。
    let installedNow: string[] = [];
    setup({
      plugins: [
        { id: "pi9-a", title: "件九甲", scene: "programming" },
        { id: "pi9-b", title: "件九乙", scene: "programming" },
      ],
      ledger: () => ({ plugins: installedNow.map((id) => ({ id })) }),
      onInstall: (cmd, args) => {
        if (cmd === "market_install") installedNow.push(String(args.pluginId));
        return undefined;
      },
    });
    // 第一次：两件都默认勾上；用户取消勾乙，装甲
    await toRecommendStep();
    await waitFor(() => expect(boxOf("件九甲").checked).toBe(true));
    await waitFor(() => expect(boxOf("件九乙").checked).toBe(true));
    await click(boxOf("件九乙"));
    await next();
    await installSettled();
    expect(installedNow).toEqual(["pi9-a"]);
    // 第二次（应用没重启）：甲已装 → 标出、不勾；乙上一次用户取消过 → 保持不勾
    await toRecommendStep();
    await waitFor(() => expect(row("件九甲").textContent).toContain("已安装"));
    expect(boxOf("件九甲").checked).toBe(false);
    expect(boxOf("件九乙").checked).toBe(false);
  });
});
