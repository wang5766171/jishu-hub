import { describe, expect, it, vi } from "vitest";
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
