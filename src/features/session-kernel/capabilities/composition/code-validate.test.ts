import { describe, expect, it } from "vitest";
import { validateComponentJs } from "./code-validate";

/** 2a（v0.9.5 需求1，原需求26）：component.js 语法 + 契约校验。 */
describe("2a：validateComponentJs 语法与契约校验", () => {
  const GOOD = `JishuPlugin.register("session.demo", {
  version: 1,
  component: (api) => (props) =>
    api.h("div", null, "hi"),
});`;

  it("合法代码通过（语法 + 契约全绿）", () => {
    const r = validateComponentJs(GOOD);
    expect(r.valid).toBe(true);
    expect(r.syntax).toEqual([]);
    expect(r.contract).toEqual([]);
  });

  it("语法错误给出行号与原因（2a-1：底部错误面板数据源）", () => {
    const r = validateComponentJs(`const a = {
JishuPlugin.register("x", {`); // 未闭合对象
    expect(r.valid).toBe(false);
    expect(r.syntax.length).toBeGreaterThan(0);
    expect(r.syntax[0].line).toBeGreaterThanOrEqual(2);
    expect(r.syntax[0].message.length).toBeGreaterThan(0);
    // 语法失败时契约层跳过（无从解析）。
    expect(r.contract).toEqual([]);
  });

  it("缺 register 调用被拒", () => {
    const r = validateComponentJs(`console.log("no register");\n`);
    expect(r.valid).toBe(false);
    expect(r.contract.some((c) => c.includes("JishuPlugin.register"))).toBe(true);
  });

  it("version 错误被拒（API 版本检查）", () => {
    const r = validateComponentJs(`JishuPlugin.register("session.demo", {
  version: 2,
  component: (api) => (props) => null,
});`);
    expect(r.contract.some((c) => c.includes("version 应为字面量 1"))).toBe(true);
  });

  it("component 非函数被拒", () => {
    const r = validateComponentJs(`JishuPlugin.register("session.demo", {
  version: 1,
  component: 42,
});`);
    expect(r.contract.some((c) => c.includes("component") && c.includes("函数"))).toBe(true);
  });

  it("单参数形态给出降级提示（兼容但不推荐）", () => {
    const r = validateComponentJs(`JishuPlugin.register({
  version: 1,
  component: (api) => (props) => null,
});`);
    expect(r.contract.some((c) => c.includes("两参数形态"))).toBe(true);
  });

  it("register id 与清单 plugin.id 不一致被拒（提供 pluginId 时）", () => {
    const r = validateComponentJs(GOOD, { pluginId: "session.other" });
    expect(r.contract.some((c) => c.includes("不一致"))).toBe(true);
  });

  it("id 一致时通过", () => {
    const r = validateComponentJs(GOOD, { pluginId: "session.demo" });
    expect(r.valid).toBe(true);
  });
});
