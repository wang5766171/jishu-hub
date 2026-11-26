/**
 * v0.9.8 评审修复轮 R3（二轮评审 M 域）：装一件的唯一出口 installRef。
 * 守的是：结果判读只认「装成」（P2-3）、已装态不明不装——形状看不懂也算不明
 * （P2-4a）、抛出的错误可直接显示（P2-7 / P2-14d）、同一件同一时刻只装一次
 * （P2-8）、已装的件按指定版本重装（P2-2a，不被「已装就不装」拦下）。
 */
import i18n from "@/i18n";
import { userFacingError } from "@/lib/user-facing-error";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirmDialog: () => ({ confirm: confirmMock, alert: async () => {}, dialogNode: null }),
}));

import { installRef, reinstallRef } from "./install";

const CONFLICT = {
  status: "conflict",
  conflicts: [
    { tool: "web_search", opponent_source: "npm:pi-web-access@0.32.0", opponent_display: "联网搜索", opponent_builtin: true },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 后端替身：三份台账默认读得到且为空；onCommand 优先（返回 undefined 落到默认）。 */
function backend(opts?: {
  ledgers?: (cmd: string) => unknown;
  onCommand?: (cmd: string, args: Record<string, unknown>) => unknown;
}) {
  invokeCommand.mockReset();
  invokeCommand.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd === "plugin_list" || cmd === "skillhub_installed" || cmd === "pi_package_installed_sources") {
      const v = opts?.ledgers?.(cmd);
      if (v !== undefined) return v instanceof Promise ? v : Promise.resolve(v);
    }
    const custom = opts?.onCommand?.(cmd, args);
    if (custom !== undefined) return custom instanceof Promise ? custom : Promise.resolve(custom);
    if (cmd === "plugin_list") return Promise.resolve({ plugins: [] });
    if (cmd === "skillhub_installed") return Promise.resolve({});
    if (cmd === "pi_package_installed_sources") return Promise.resolve([]);
    return Promise.resolve("installed");
  });
}

const callsOf = (cmd: string) => invokeCommand.mock.calls.filter(([c]) => c === cmd);
/** 落到屏幕上的文字（各展示处都经 userFacingError）。 */
const shown = async (p: Promise<unknown>) => {
  try {
    await p;
    return "(resolved)";
  } catch (e) {
    return userFacingError(e);
  }
};

beforeAll(async () => {
  await i18n.changeLanguage("zh");
});

beforeEach(() => {
  confirmMock.mockReset();
});

describe("installRef · 结果判读只认「装成」（P2-3）", () => {
  it("P2-3-U1 在线安装返回不认识的结果 → 抛错，不算装成", async () => {
    // 修前：status 不是 conflict 就算装成（连 undefined 都算）
    for (const outcome of [{ status: "weird" }, {}, undefined, "installed", null]) {
      backend({ onCommand: (cmd) => (cmd === "pi_package_install_online" ? outcome : undefined) });
      const text = await shown(installRef("pi:npm:pkg-x"));
      expect(text, JSON.stringify(outcome)).toBe("安装结果无法确认，未记为已安装");
      expect(callsOf("pi_package_install_confirmed")).toHaveLength(0);
      expect(confirmMock).not.toHaveBeenCalled();
    }
  });

  it("P2-3-U2 确认安装的返回不合预期 → 抛错", async () => {
    for (const confirmed of [undefined, {}, { disabled: "x" }]) {
      confirmMock.mockResolvedValue(true);
      backend({
        onCommand: (cmd) =>
          cmd === "pi_package_install_online" ? CONFLICT : cmd === "pi_package_install_confirmed" ? confirmed : undefined,
      });
      expect(await shown(installRef("pi:npm:pkg-x", undefined, () => Promise.resolve(true)))).toBe(
        "安装结果无法确认，未记为已安装",
      );
    }
  });

  it("守卫：装成 / 撞名取消 / 撞名确认三种结果的判读不变", async () => {
    backend({ onCommand: (cmd) => (cmd === "pi_package_install_online" ? { status: "installed" } : undefined) });
    expect(await installRef("pi:npm:pkg-x")).toEqual({ kind: "installed", stopped: [] });

    backend({ onCommand: (cmd) => (cmd === "pi_package_install_online" ? CONFLICT : undefined) });
    // 没传确认函数：默认不装（安全方向）
    expect(await installRef("pi:npm:pkg-x")).toEqual({ kind: "declined" });
    confirmMock.mockResolvedValue(false);
    expect(await installRef("pi:npm:pkg-x", { via: "market-zone" }, async () => false)).toEqual({ kind: "declined" });
    expect(callsOf("pi_package_install_confirmed")).toHaveLength(0);

    backend({
      onCommand: (cmd) =>
        cmd === "pi_package_install_online"
          ? CONFLICT
          : cmd === "pi_package_install_confirmed"
            ? { disabled: [{ opponent_display: "联网搜索" }] }
            : undefined,
    });
    expect(await installRef("pi:npm:pkg-x", { via: "market-zone" }, async () => true)).toEqual({
      kind: "installed",
      stopped: ["联网搜索"],
    });
    // 确认后的安装带同一份安装链信息
    expect(callsOf("pi_package_install_confirmed")).toEqual([
      ["pi_package_install_confirmed", { source: "npm:pkg-x", meta: { via: "market-zone" } }],
    ]);
  });

  it("守卫：执行时已装 → already，不发安装调用；非 pi 件报错即没装成", async () => {
    backend({ ledgers: (cmd) => (cmd === "skillhub_installed" ? { s1: "1.0.0" } : undefined) });
    expect(await installRef("skillhub:s1")).toEqual({ kind: "already" });
    expect(callsOf("skillhub_install")).toHaveLength(0);

    backend({ onCommand: (cmd) => (cmd === "skillhub_install" ? Promise.reject("下载失败：网络不可达") : undefined) });
    expect(await shown(installRef("skillhub:s2"))).toBe("下载失败：网络不可达");
  });
});

describe("installRef · 已装态不明不装（P2-4a / P2-7）", () => {
  it("P2-4a-U2 台账形状不合预期（插件清单没有清单字段）→ 不放行", async () => {
    // 修前形状不合预期按空处理 → 这里会直接发起安装
    backend({ ledgers: (cmd) => (cmd === "plugin_list" ? {} : undefined) });
    expect(await shown(installRef("curated:a"))).toBe("无法读取已安装清单，本次未安装");
    expect(callsOf("market_install")).toHaveLength(0);
  });

  it("P2-7-U1 出口抛出的错误都是可直接显示的：不带英文内部话、不带 Error: 前缀与机器前缀", async () => {
    backend();
    // P2-14d：修前是 `unknown ref: ${ref}`
    expect(await shown(installRef("bogus:thing"))).toBe("无法识别这个安装项，本次未安装");

    backend({ ledgers: () => Promise.reject("boom") });
    expect(await shown(installRef("curated:a"))).toBe("无法读取已安装清单，本次未安装");

    // 后端报错：出口交出来的就已经是给用户看的文字——调用方拿 message 直接上屏即可
    //（开头的机器前缀、结尾括号里的英文原文都不在里面）。这里直接看 message，
    // 不经 shown()：shown() 自己也会洗一遍，会把「出口没洗」这件事盖住。
    backend({
      onCommand: (cmd) => (cmd === "pi_package_install_online" ? Promise.reject("[install_failed] 安装失败（npm ERR! network）") : undefined),
    });
    const thrown = await installRef("pi:npm:pkg-x").then(
      () => "(resolved)",
      (e: Error) => e.message,
    );
    expect(thrown).toBe("安装失败");
  });
});

describe("installRef · 同一件同一时刻只装一次（P2-8）", () => {
  /** 让出事件循环：第二次调用若另起了一次安装，这时安装调用数会变成 2。 */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("P2-8-U1 并行装同一件：只发一次安装调用，两处拿到同一个结果", async () => {
    const install = deferred<{ status: string }>();
    backend({ onCommand: (cmd) => (cmd === "pi_package_install_online" ? install.promise : undefined) });
    const first = installRef("pi:npm:pkg-x");
    const second = installRef("pi:npm:pkg-x");
    await vi.waitFor(() => expect(callsOf("pi_package_install_online")).toHaveLength(1));
    await flush();
    expect(callsOf("pi_package_install_online")).toHaveLength(1);
    install.resolve({ status: "installed" });
    expect(await first).toEqual({ kind: "installed", stopped: [] });
    expect(await second).toEqual({ kind: "installed", stopped: [] });
  });

  it("P2-8-U2 同一件的不同写法（带版本 / 不带版本、git 源带 https 前缀）算同一件", async () => {
    const install = deferred<{ status: string }>();
    backend({ onCommand: (cmd) => (cmd === "pi_package_install_online" ? install.promise : undefined) });
    const a = installRef("pi:npm:pkg-x@1.0.0");
    const b = installRef("pi:npm:pkg-x");
    const c = installRef("pi:git:https://github.com/a/b");
    const d = installRef("pi:git:github.com/a/b");
    await vi.waitFor(() => expect(callsOf("pi_package_install_online")).toHaveLength(2));
    await flush();
    expect(callsOf("pi_package_install_online").map(([, args]) => (args as { source: string }).source)).toEqual([
      "npm:pkg-x@1.0.0",
      "git:https://github.com/a/b",
    ]);
    install.resolve({ status: "installed" });
    for (const p of [a, b, c, d]) expect((await p).kind).toBe("installed");
  });

  it("P2-8-U3 守卫：不同的件互不阻塞", async () => {
    const gate = deferred<string>();
    backend({ onCommand: (cmd) => (cmd === "market_install" ? gate.promise : undefined) });
    void installRef("curated:a").catch(() => undefined);
    void installRef("curated:b").catch(() => undefined);
    // gate 没放行之前，两件的安装调用都已发出
    await vi.waitFor(() =>
      expect(callsOf("market_install").map(([, args]) => (args as { pluginId: string }).pluginId)).toEqual(["a", "b"]),
    );
    gate.resolve("installed");
  });

  it("P2-8-U4 第一件失败：两处拿到同一个失败；之后可以再装", async () => {
    const install = deferred<string>();
    let attempts = 0;
    backend({
      onCommand: (cmd) => {
        if (cmd !== "pi_package_install_online") return undefined;
        // 第一次安装失败；之后的（释放后的新一次）成功
        attempts += 1;
        return attempts === 1 ? install.promise : { status: "installed" };
      },
    });
    const first = shown(installRef("pi:npm:pkg-x"));
    const second = shown(installRef("pi:npm:pkg-x"));
    await vi.waitFor(() => expect(callsOf("pi_package_install_online")).toHaveLength(1));
    install.reject("安装失败");
    expect(await first).toBe("安装失败");
    expect(await second).toBe("安装失败");
    expect(callsOf("pi_package_install_online")).toHaveLength(1);
    // 在途集合已释放：再装是新的安装调用
    expect((await installRef("pi:npm:pkg-x")).kind).toBe("installed");
    expect(callsOf("pi_package_install_online")).toHaveLength(2);
  });

  it("撞名时只弹一次确认卡；两处拿到同一个决断", async () => {
    const answer = deferred<boolean>();
    backend({ onCommand: (cmd) => (cmd === "pi_package_install_online" ? CONFLICT : undefined) });
    const a = installRef("pi:npm:pkg-x", undefined, () => answer.promise);
    // 第二处的确认函数不该被问到
    const b = installRef("pi:npm:pkg-x", undefined, async () => {
      throw new Error("第二处不该再弹确认卡");
    });
    b.catch(() => undefined);
    await vi.waitFor(() => expect(callsOf("pi_package_install_online")).toHaveLength(1));
    await flush();
    answer.resolve(false);
    expect(await a).toEqual({ kind: "declined" });
    expect(await b).toEqual({ kind: "declined" });
    expect(callsOf("pi_package_install_online")).toHaveLength(1);
  });
});

describe("reinstallRef · 已装的件按指定版本重装（P2-2a，插件中心「卸载更新」）", () => {
  it("件已在已装清单里：照样发起安装（不被「已装就不装」拦下）", async () => {
    const install = deferred<{ status: string }>();
    backend({
      ledgers: (cmd) => (cmd === "pi_package_installed_sources" ? ["npm:pkg-x@2.0.0"] : undefined),
      onCommand: (cmd) => (cmd === "pi_package_install_online" ? install.promise : undefined),
    });
    const result = reinstallRef("pi:npm:pkg-x@1.0.0");
    // 朴素修法（直接改调 installRef）在这里会被「已装就不装」拦下：安装调用不会发出
    await vi.waitFor(() => expect(callsOf("pi_package_install_online")).toHaveLength(1));
    install.resolve({ status: "installed" });
    expect(await result).toEqual({ kind: "installed", stopped: [] });
    expect(callsOf("pi_package_install_online")).toEqual([
      ["pi_package_install_online", { source: "npm:pkg-x@1.0.0", meta: { via: "manual" } }],
    ]);
  });

  it("重装不读台账（件在不在由调用方决定）；结果判读与安装同一条路", async () => {
    backend({
      ledgers: () => Promise.reject("台账读不到"),
      onCommand: (cmd) => (cmd === "pi_package_install_online" ? CONFLICT : undefined),
    });
    expect(await reinstallRef("pi:npm:pkg-x@1.0.0", undefined, async () => false)).toEqual({ kind: "declined" });
    expect(callsOf("pi_package_install_online")).toHaveLength(1);
    expect(callsOf("pi_package_install_confirmed")).toHaveLength(0);
  });

  it("只对 pi: 件开放：技能 / 精选件的重装会整目录重写，拒绝", async () => {
    backend();
    expect(await shown(reinstallRef("skillhub:s1"))).toBe("无法识别这个安装项，本次未安装");
    expect(await shown(reinstallRef("curated:a"))).toBe("无法识别这个安装项，本次未安装");
    expect(invokeCommand).not.toHaveBeenCalledWith("skillhub_install", expect.anything());
    expect(invokeCommand).not.toHaveBeenCalledWith("market_install", expect.anything());
  });

  it("与安装共用同一个在途集合：同一件正在装时，重装等它的结果", async () => {
    const install = deferred<{ status: string }>();
    backend({ onCommand: (cmd) => (cmd === "pi_package_install_online" ? install.promise : undefined) });
    void installRef("pi:npm:pkg-x").catch(() => undefined);
    const again = reinstallRef("pi:npm:pkg-x@1.0.0");
    await vi.waitFor(() => expect(callsOf("pi_package_install_online")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(callsOf("pi_package_install_online")).toHaveLength(1);
    install.resolve({ status: "installed" });
    expect((await again).kind).toBe("installed");
  });
});
