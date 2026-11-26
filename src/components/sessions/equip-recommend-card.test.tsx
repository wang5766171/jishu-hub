/**
 * v0.9.8 评审修复轮 R2：会话推荐卡——已装件不进卡（三源同一判定）、安装结果如实
 * 落行（扩展撞名弹确认卡）、安装中不出安装按钮。
 * 对应 M-用例清单 M1-9 / M2-7 / M2-8 / M3-5。确认卡用真实组件。
 */
import i18n from "@/i18n";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EquipRecommendCard, EquipSessionContext } from "./equip-recommend-card";

const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));

const CURATED = [
  { id: "video-maker", kind: "composed", title: "视频生成助手", description: "d", required: false, tags: ["视频生成"], stars: 5 },
  { id: "task-plan", kind: "agent", title: "流程规划", description: "d", required: false, tags: ["任务拆解"], stars: 5 },
  { id: "item-a", kind: "agent", title: "件甲", description: "d", required: false, tags: ["任务拆解"], stars: 4 },
  { id: "item-b", kind: "agent", title: "件乙", description: "d", required: false, tags: ["流程规划"], stars: 4 },
];

/** 后端检出工具撞名时的返回：已回滚、实际没装，等用户决断。 */
const CONFLICT = {
  status: "conflict",
  conflicts: [
    { tool: "web_search", opponent_source: "npm:pi-web-access@0.32.0", opponent_display: "联网搜索", opponent_builtin: true },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 后端替身：三份已装台账 + 推荐卡装载用到的命令；onCommand 优先。 */
function setup(opts: {
  installed?: { plugins?: string[]; skills?: string[]; pi?: string[] };
  onCommand?: (cmd: string, args: Record<string, unknown>) => unknown;
}) {
  invokeCommand.mockReset();
  invokeCommand.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    const custom = opts.onCommand?.(cmd, args);
    if (custom !== undefined) return custom instanceof Promise ? custom : Promise.resolve(custom);
    switch (cmd) {
      case "equip_config_get":
        return Promise.resolve({
          enabled: true, session_card: true, session_limit: 1,
          input_bar: true, market_zone: true, third_party: true,
        });
      case "equip_recommended_count":
        return Promise.resolve(0);
      case "equip_recommended_list":
        return Promise.resolve([]);
      case "market_list_curated":
        return Promise.resolve(CURATED);
      case "equipment_tags_list":
        return Promise.resolve([]);
      case "plugin_list":
        return Promise.resolve({ plugins: (opts.installed?.plugins ?? []).map((id) => ({ id })) });
      case "skillhub_installed":
        return Promise.resolve(Object.fromEntries((opts.installed?.skills ?? []).map((s) => [s, "1.0.0"])));
      case "pi_package_installed_sources":
        return Promise.resolve(opts.installed?.pi ?? []);
      case "pi_package_install_confirmed":
        return Promise.resolve({ disabled: [{ opponent_display: "联网搜索" }] });
      default:
        return Promise.resolve("ok");
    }
  });
}

const renderCard = (items: Array<{ ref: string; reason?: string }>) =>
  render(
    <EquipSessionContext.Provider value="session-1">
      <EquipRecommendCard payload={{ items: items.map((i) => ({ ref: i.ref, reason: i.reason ?? "" })) }} />
    </EquipSessionContext.Provider>,
  );

const card = () => document.querySelector('[data-equip-recommend="card"]') as HTMLElement | null;
const cardButton = (name: string) =>
  [...(card()?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes(name));
const rowOf = (title: string) =>
  [...(card()?.querySelectorAll("label") ?? [])].find((l) => l.textContent?.includes(title)) as HTMLLabelElement;
const callsOf = (cmd: string) => invokeCommand.mock.calls.filter(([c]) => c === cmd);

describe("会话推荐卡 · 已装件不进卡", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("M1-9 已装的件不进卡（精选 / 技能 / 扩展三源同一判定）", async () => {
    setup({
      installed: {
        plugins: ["video-maker"],
        skills: ["tts"],
        // 注册串的三种落盘形态：带版本的 npm 源、不带版本的 scoped 包、带 https 前缀的 git 源
        pi: ["npm:pkg-x@1.0.0", "npm:@scope/pkg-z", "git:https://github.com/a/b"],
      },
    });
    renderCard([
      { ref: "curated:video-maker", reason: "r" },
      { ref: "skillhub:tts", reason: "r" },
      { ref: "pi:npm:pkg-x", reason: "r" },
      { ref: "pi:npm:@scope/pkg-z", reason: "r" },
      { ref: "pi:git:github.com/a/b", reason: "r" },
      { ref: "curated:task-plan", reason: "r" },
    ]);
    await waitFor(() => expect(card()).toBeTruthy());
    expect(card()!.textContent).toContain("流程规划");
    expect(card()!.textContent).not.toContain("视频生成助手");
    expect(card()!.textContent).not.toContain("tts");
    expect(card()!.textContent).not.toContain("pkg-x");
    expect(card()!.textContent).not.toContain("@scope/pkg-z");
    expect(card()!.textContent).not.toContain("github.com/a/b");
  });
});

describe("会话推荐卡 · 安装结果如实落行", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
  });

  it("M2-7 扩展撞名 → 弹确认卡；取消 → 该件未安装、不算成功", async () => {
    setup({ onCommand: (cmd) => (cmd === "pi_package_install_online" ? CONFLICT : undefined) });
    renderCard([{ ref: "pi:npm:pkg-x", reason: "r" }]);
    await waitFor(() => expect(card()).toBeTruthy());
    await act(async () => {
      fireEvent.click(cardButton("安装选中项")!);
    });
    const title = await screen.findByText("能力重叠：pkg-x");
    const dialog = title.closest('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("「联网搜索」（工具 web_search）");
    // 等用户决断期间：行标「需确认」
    expect(card()!.textContent).toContain("需确认");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    });
    await waitFor(() => expect(card()!.textContent).toContain("安装完成：成功 0 项、失败 0 项、未安装 1 项"));
    expect(callsOf("pi_package_install_confirmed")).toHaveLength(0);
    expect(rowOf("pkg-x").textContent).toContain("未安装");
  });

  it("M2-8 扩展撞名 → 确认 → 停用对手并安装", async () => {
    setup({ onCommand: (cmd) => (cmd === "pi_package_install_online" ? CONFLICT : undefined) });
    renderCard([{ ref: "pi:npm:pkg-x", reason: "r" }]);
    await waitFor(() => expect(card()).toBeTruthy());
    await act(async () => {
      fireEvent.click(cardButton("安装选中项")!);
    });
    const title = await screen.findByText("能力重叠：pkg-x");
    const dialog = title.closest('[role="dialog"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "停用并安装" }));
    });
    await waitFor(() => expect(card()!.textContent).toContain("安装完成：成功 1 项、失败 0 项"));
    expect(callsOf("pi_package_install_confirmed")).toEqual([["pi_package_install_confirmed", { source: "npm:pkg-x", meta: { via: "recommend-card", title: "npm:pkg-x", tags: [] } }]]);
    expect(card()!.textContent).not.toContain("未安装");
  });

  it("M3-5 安装中不出安装按钮（只有「取消剩余项」）", async () => {
    const slow = deferred<string>();
    setup({
      onCommand: (cmd, args) =>
        cmd === "market_install" && (args as { pluginId: string }).pluginId === "item-a" ? slow.promise : undefined,
    });
    renderCard([{ ref: "curated:item-a" }, { ref: "curated:item-b" }]);
    await waitFor(() => expect(cardButton("安装选中项")).toBeTruthy());
    await act(async () => {
      fireEvent.click(cardButton("安装选中项")!);
    });
    await waitFor(() => expect(callsOf("market_install")).toHaveLength(1));
    // 安装进行中：点了会对同一批件并行再装一轮——安装入口不出现
    expect(cardButton("取消剩余项")).toBeTruthy();
    expect(cardButton("安装选中项")).toBeUndefined();
    await act(async () => {
      slow.resolve("installed");
    });
    await waitFor(() => expect(card()!.textContent).toContain("安装完成：成功 2 项、失败 0 项"));
    expect(callsOf("market_install")).toHaveLength(2);
  });

  // 二轮评审 R3（P2-15）：行上的失败原因是执行器落行时清洗好的——推荐卡不改，
  // 这里守住展开出来的是给用户看的文字。
  it("P2-15-U4 推荐卡展开的原因是清洗后的文字（不带机器前缀、Error: 与括号里的英文原文）", async () => {
    setup({
      onCommand: (cmd) =>
        cmd === "pi_package_install_online" ? Promise.reject("[install_failed] 安装失败（npm ERR! network）") : undefined,
    });
    renderCard([{ ref: "pi:npm:pkg-x", reason: "r" }]);
    await waitFor(() => expect(cardButton("安装选中项")).toBeTruthy());
    await act(async () => {
      fireEvent.click(cardButton("安装选中项")!);
    });
    await waitFor(() => expect(cardButton("安装失败，查看原因")).toBeTruthy());
    await act(async () => {
      fireEvent.click(cardButton("安装失败，查看原因")!);
    });
    // 修前：卡上是「[install_failed] 安装失败（npm ERR! network）」原文
    const reason = rowOf("pkg-x").querySelector(".break-all")?.textContent ?? "";
    expect(reason).toBe("安装失败");
  });
});
