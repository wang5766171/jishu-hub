import { describe, expect, it, vi, beforeEach } from "vitest";
import { expandThemeAssetUrls, warnOutOfContractTokens } from "./plugin-theme";

describe("需求14 M2：theme.css 资产记号展开（R3-b 内联注入的 url 通路）", () => {
  const toUrl = (p: string) => `http://asset.localhost/${p}`;
  const BS = String.fromCharCode(92); // 反斜杠（避免源码转义歧义）

  it("@file: 记号展开为 asset 绝对 URL；反斜杠目录归一；非记号 url 不动", () => {
    const dir = ["C:", "Users", "u", ".jishu-hub", "plugins", "session.theme-x"].join(BS);
    const css = [
      `[data-jishu-theme="x"] {`,
      `  background-image: url(@file:bg.jpg);`,
      `  --x: url( @file:sub tile.png );`,
      `  border-image: url(https://cdn.example/x.png);`,
      `}`,
    ].join("\n");
    const out = expandThemeAssetUrls(css, dir, toUrl);
    expect(out).toContain(
      'url("http://asset.localhost/C:/Users/u/.jishu-hub/plugins/session.theme-x/bg.jpg")',
    );
    expect(out).toContain("sub tile.png"); // 记号内含空格按原样透传（平铺纪律外属用户责任）
    expect(out).toContain("https://cdn.example/x.png"); // 非 @file: 记号不动
  });

  it("无记号内容原样返回", () => {
    expect(expandThemeAssetUrls("a{color:red}", "C:/d", toUrl)).toBe("a{color:red}");
  });
});

describe("需求14 M2：令牌越权提醒（02 §4.2 warning 不阻塞）", () => {
  it("契约外变量 warn、契约内静默", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnOutOfContractTokens("[x]{--color-background:1;--message-user-bg:2;}", "p.ok");
    expect(warn).not.toHaveBeenCalled();
    warnOutOfContractTokens("[x]{--color-random-x:1;--hack:2}", "p.bad");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("--color-random-x");
    warn.mockRestore();
  });
});


// ── v0.9.6 需求7：启动竞态不回落 / fallback 不持久化 / 激活回写自愈 ──
import { renderHook, waitFor } from "@testing-library/react";

const mockPersist = vi.fn();
const mockTransient = vi.fn();
let composedLoaded = false;
let descriptorPresent = false;
let readFileOk = true;

vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({ theme: "session.theme-x", setTheme: mockPersist, setThemeTransient: mockTransient }),
  isBuiltinTheme: (t: string) => !t.startsWith("session."),
}));
vi.mock("@/features/session-kernel/capabilities/composition/loader", () => ({
  composedReady: () => composedLoaded,
  composedVersion: () => 1,
  subscribeComposed: () => () => {},
}));
vi.mock("@/features/session-kernel/plugins/registry", () => ({
  listSessionPlugins: () =>
    descriptorPresent
      ? [{ id: "session.theme-x", theme: { css: "@file:theme.css", base: "dark" } }]
      : [],
}));
vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand: vi.fn(async (cmd: string) => {
    if (cmd === "plugin_list") return { plugins: [{ id: "session.theme-x", enabled: true }] };
    if (cmd === "plugin_read_file") {
      if (!readFileOk) throw new Error("read fail");
      return { path: "D:/p/theme.css", content: ":root{}" };
    }
    return {};
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));

import { usePluginTheme } from "./plugin-theme";

describe("v0.9.6 需求7：主题回落竞态防护", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    composedLoaded = false;
    descriptorPresent = false;
    readFileOk = true;
    document.querySelectorAll("style").forEach(e => e.remove());
    document.documentElement.removeAttribute("data-jishu-theme");
  });

  it("F1：组合清单未就绪（启动竞态）不判定缺失不回落", async () => {
    renderHook(() => usePluginTheme());
    await new Promise(r => setTimeout(r, 50));
    expect(mockPersist).not.toHaveBeenCalled();
    expect(mockTransient).not.toHaveBeenCalled();
  });

  it("F2：就绪后仍缺 → 仅内存回落（不持久化）", async () => {
    composedLoaded = true;
    renderHook(() => usePluginTheme());
    await waitFor(() => expect(mockTransient).toHaveBeenCalledWith("dark"));
    expect(mockPersist).not.toHaveBeenCalledWith("dark");
  });

  it("F2：装载失败（读 css 抛错）→ 仅内存回落", async () => {
    composedLoaded = true;
    descriptorPresent = true;
    readFileOk = false;
    renderHook(() => usePluginTheme());
    await waitFor(() => expect(mockTransient).toHaveBeenCalledWith("dark"));
    expect(mockPersist).not.toHaveBeenCalledWith("dark");
  });

  it("F3：激活成功 → 幂等回写持久值（自愈暗伤）+ 挂载样式", async () => {
    composedLoaded = true;
    descriptorPresent = true;
    renderHook(() => usePluginTheme());
    await waitFor(() => expect(mockPersist).toHaveBeenCalledWith("session.theme-x"));
    expect(document.querySelector("style[data-jishu-plugin-theme]")).not.toBeNull();
    expect(document.documentElement.getAttribute("data-jishu-theme")).toBe("session.theme-x");
  });
});
