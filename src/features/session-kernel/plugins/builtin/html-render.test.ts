import { describe, expect, it } from "vitest";
import { injectHeightHarness, isRenderableHtmlBlock } from "./html-render";

describe("HTML 渲染判定（v0.9.3 测试期扩展：片段渲染）", () => {
  it("完整文档命中（原口径保留）", () => {
    expect(isRenderableHtmlBlock("<!doctype html><html><body>x</body></html>")).toBe(true);
    expect(isRenderableHtmlBlock("<div>a</div>\n</HTML>")).toBe(true);
  });

  it("含标签的片段命中（div 卡片——用户主场景）", () => {
    expect(isRenderableHtmlBlock('<div style="font-family:KaiTi">卡片</div>')).toBe(true);
    expect(isRenderableHtmlBlock("<section>\n  <p>hello</p>\n</section>")).toBe(true);
    expect(isRenderableHtmlBlock("<img src=\"x.png\"/>")).toBe(true);
    expect(isRenderableHtmlBlock("<br/>")).toBe(true);
  });

  it("无标签纯文本不渲染（普通代码块）", () => {
    expect(isRenderableHtmlBlock("plain text")).toBe(false);
    expect(isRenderableHtmlBlock("a < b and c > d")).toBe(false);
    expect(isRenderableHtmlBlock("")).toBe(false);
  });
});

describe("运行脚本注入（v0.9.3 测试期：外置同源脚本——CSP script-src 'self' 下内联脚本被拦）", () => {
  it("完整文档：注入到 </body> 之前，src 指向同源 harness", () => {
    const out = injectHeightHarness("<!doctype html><html><body><div>x</div></body></html>");
    const idxHarness = out.indexOf("<script src=");
    const idxBody = out.toLowerCase().indexOf("</body>");
    expect(idxHarness).toBeGreaterThan(-1);
    expect(idxBody).toBeGreaterThan(idxHarness);
    expect(out).toContain("/jishu-html-harness.js");
    expect(out.toLowerCase().endsWith("</body></html>")).toBe(true);
  });

  it("片段：直接追加在末尾", () => {
    const out = injectHeightHarness('<div style="color:red">卡片</div>');
    expect(out.startsWith('<div style="color:red">卡片</div>')).toBe(true);
    expect(out).toContain("<script src=");
    expect(out).toContain("/jishu-html-harness.js");
  });
});
