/** v0.9.8 评审修复轮 R2（R2-6）：已装集——三份台账的读取与归一。对应 M-用例清单 M1-6。 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildInstalledRefs,
  fetchInstalledExtensionSources,
  fetchInstalledRefs,
  isInstalledRef,
  packageKeyOf,
  piRefOf,
  sameInstalledLedgers,
} from "./installed";

const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));

describe("已装集归一（installed.ts）", () => {
  it("M1-6 三份台账归一成一个集合；带版本 / 带 https 前缀的注册串算同一件", () => {
    const refs = buildInstalledRefs({
      pluginIds: ["pi-lens", "task-plan"],
      skills: { pmaster: "1.0.0" },
      piSources: ["npm:pkg-x@1.0.0", "npm:@scope/pkg-y@2.1.0", "git:https://github.com/a/b", "npm:@scope/pkg-z"],
    });
    expect([...refs].sort()).toEqual([
      "curated:pi-lens",
      "curated:task-plan",
      "pi:git:github.com/a/b",
      "pi:npm:@scope/pkg-y",
      "pi:npm:@scope/pkg-z",
      "pi:npm:pkg-x",
      "skillhub:pmaster",
    ]);
    // ref 的几种写法都判已装：不带版本 / 带版本 / git 源不带 https 前缀。
    expect(isInstalledRef(refs, "pi:npm:pkg-x")).toBe(true);
    expect(isInstalledRef(refs, "pi:npm:pkg-x@0.9.0")).toBe(true);
    expect(isInstalledRef(refs, "pi:git:github.com/a/b")).toBe(true);
    expect(isInstalledRef(refs, "skillhub:pmaster")).toBe(true);
    expect(isInstalledRef(refs, "curated:task-plan")).toBe(true);
    expect(isInstalledRef(refs, "pi:npm:pkg-q")).toBe(false);
    expect(isInstalledRef(refs, "skillhub:other")).toBe(false);
  });

  it("注册串去版本：scoped 包的 @scope 不是版本分隔；不带版本的原样", () => {
    expect(packageKeyOf("npm:pkg@1.0")).toBe("npm:pkg");
    expect(packageKeyOf("npm:@scope/pkg@1.0")).toBe("npm:@scope/pkg");
    // 修前的 lastIndexOf("@") 会把不带版本的 scoped 包截成 "npm:"
    expect(packageKeyOf("npm:@scope/pkg")).toBe("npm:@scope/pkg");
    expect(packageKeyOf("git:github.com/a/b")).toBe("git:github.com/a/b");
    expect(piRefOf("git:https://github.com/a/b")).toBe("pi:git:github.com/a/b");
  });

  it("台账内容相同（与顺序无关）→ 判相同", () => {
    const a = { pluginIds: ["x", "y"], skills: { s: "1" }, piSources: ["npm:p@1"] };
    expect(sameInstalledLedgers(a, { pluginIds: ["y", "x"], skills: { s: "1" }, piSources: ["npm:p@1"] })).toBe(true);
    expect(sameInstalledLedgers(a, { ...a, pluginIds: ["x"] })).toBe(false);
    expect(sameInstalledLedgers(a, { ...a, skills: { s: "2" } })).toBe(false);
    expect(sameInstalledLedgers(null, null)).toBe(true);
    expect(sameInstalledLedgers(null, a)).toBe(false);
  });
});

describe("已装台账读取（fetchInstalledRefs）", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
  });

  it("一次读齐三份台账并归一", async () => {
    invokeCommand.mockImplementation((cmd: string) => {
      if (cmd === "plugin_list") return Promise.resolve({ plugins: [{ id: "pi-lens", enabled: true }] });
      if (cmd === "skillhub_installed") return Promise.resolve({ pmaster: "1.0.0" });
      if (cmd === "pi_package_installed_sources") return Promise.resolve(["npm:pkg-x@1.0.0"]);
      return Promise.resolve({});
    });
    const refs = await fetchInstalledRefs();
    expect([...(refs ?? [])].sort()).toEqual(["curated:pi-lens", "pi:npm:pkg-x", "skillhub:pmaster"]);
    expect(invokeCommand).toHaveBeenCalledWith("plugin_list");
    expect(invokeCommand).toHaveBeenCalledWith("skillhub_installed");
    expect(invokeCommand).toHaveBeenCalledWith("pi_package_installed_sources");
  });

  it("任一份读不到 → null（已装态不明，不能当成「都没装」）", async () => {
    invokeCommand.mockImplementation((cmd: string) => {
      if (cmd === "skillhub_installed") return Promise.reject("boom");
      return Promise.resolve({ plugins: [] });
    });
    expect(await fetchInstalledRefs()).toBeNull();
  });

  // v0.9.8 评审修复轮 R3（二轮评审 P2-4a）：修前「返回形状不合预期时按空台账
  // 处理」（替身 / 旧后端），本用例把它锁成预期。方向不安全——已装态不明按空，
  // 执行前判定就会放行。改为与「读不到」同一条路：返回 null。
  it("P2-4a-U1 台账形状不合预期 → null（与读不到同一条路），不当成「都没装」", async () => {
    const shapes: Array<[string, unknown]> = [
      // 插件清单：没有清单 / 清单不是数组 / 清单项缺 id
      ["plugin_list", {}],
      ["plugin_list", { plugins: {} }],
      ["plugin_list", { plugins: [{ enabled: true }] }],
      ["plugin_list", null],
      // 技能台账：不是对象（数组 / 字符串 / null）/ 版本不是字符串
      ["skillhub_installed", []],
      ["skillhub_installed", "x"],
      ["skillhub_installed", null],
      ["skillhub_installed", { s: 1 }],
      // 扩展源：不是数组 / 含非字符串
      ["pi_package_installed_sources", {}],
      ["pi_package_installed_sources", [1]],
    ];
    for (const [bad, shape] of shapes) {
      invokeCommand.mockReset();
      invokeCommand.mockImplementation((cmd: string) => {
        if (cmd === bad) return Promise.resolve(shape);
        if (cmd === "plugin_list") return Promise.resolve({ plugins: [] });
        if (cmd === "skillhub_installed") return Promise.resolve({});
        return Promise.resolve([]);
      });
      expect(await fetchInstalledRefs(), `${bad} → ${JSON.stringify(shape)}`).toBeNull();
    }
  });

  it("P2-4a-U1 形状合预期的边界仍然读得到（清单项多带字段、技能台账为空对象）", async () => {
    invokeCommand.mockImplementation((cmd: string) => {
      if (cmd === "plugin_list") return Promise.resolve({ plugins: [{ id: "pi-lens", enabled: true, kind: "manifest" }], manifest_errors: [] });
      if (cmd === "skillhub_installed") return Promise.resolve({});
      if (cmd === "pi_package_installed_sources") return Promise.resolve(["git:https://github.com/a/b"]);
      return Promise.resolve({});
    });
    expect([...((await fetchInstalledRefs()) ?? [])].sort()).toEqual(["curated:pi-lens", "pi:git:github.com/a/b"]);
  });
});

describe("已装扩展清单读取（fetchInstalledExtensionSources）", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
  });

  it("读到 → 原样返回；一个都没装 → 空清单（这是「读到了、确实没有」）", async () => {
    invokeCommand.mockResolvedValueOnce(["npm:pkg-x@1.0.0"]);
    expect(await fetchInstalledExtensionSources()).toEqual(["npm:pkg-x@1.0.0"]);
    invokeCommand.mockResolvedValueOnce([]);
    expect(await fetchInstalledExtensionSources()).toEqual([]);
  });

  it("读不到（后端报错：扩展设置文件读不到或不是合法 JSON）→ null，不能当成「一个都没装」", async () => {
    invokeCommand.mockRejectedValueOnce("settings.json 不是合法 JSON");
    expect(await fetchInstalledExtensionSources()).toBeNull();
  });

  // 二轮评审 P2-4a 的同根因入口：读到了但形状不合预期，修前同样按空清单走
  //（插件中心会显示「暂无插件」）。
  it("P2-4a-U3 形状不合预期（不是字符串数组）→ null，与读不到同一条路", async () => {
    for (const shape of [{}, [1], "npm:pkg-x", null]) {
      invokeCommand.mockReset();
      invokeCommand.mockResolvedValueOnce(shape);
      expect(await fetchInstalledExtensionSources(), JSON.stringify(shape)).toBeNull();
    }
  });
});
