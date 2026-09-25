import { describe, expect, it, beforeAll } from "vitest";
import { runHubValidation } from "./cli-validate-bridge";
import { rendererRegistry } from "./renderers/registry";

/** 1c（v0.9.5 需求1，原需求26）：CLI validate 的 hub 侧校验器桥——与 GUI
 *  向导同一份 TS 实现（validateManifest/validatePipeline）的请求级包装。 */
describe("1c：CLI validate 跨进程校验桥", () => {
  beforeAll(() => {
    if (!rendererRegistry.get("render.list")) {
      rendererRegistry.register({ key: "render.list", component: () => null });
    }
  });

  it("合法组合式清单（渲染臂）通过", () => {
    const result = runHubValidation({
      nonce: 1,
      dir: "/tmp/x",
      manifest: {
        plugin: { id: "session.ok", name: "ok" },
        kind: "session-composed",
        source: { type: "messages" },
        render: { component: "render.list", mount: "dock-panel" },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("非法配对（signal 源配 dock-panel）被拒，错误与 GUI 同文案", () => {
    const result = runHubValidation({
      nonce: 2,
      dir: "/tmp/x",
      manifest: {
        plugin: { id: "session.bad", name: "bad" },
        kind: "session-composed",
        source: { type: "signal" },
        render: { component: "render.list", mount: "dock-panel" },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("不接受源类型"))).toBe(true);
  });

  it("纯流水线清单（无渲染臂）通过（1a 语义：不强制 source/render）", () => {
    const result = runHubValidation({
      nonce: 3,
      dir: "/tmp/x",
      manifest: {
        plugin: { id: "session.flow", name: "flow" },
        kind: "session-composed",
        pipeline: { stages: [{ name: "讨论", template: "phase.discuss" }] },
      },
    });
    expect(result.valid).toBe(true);
  });

  it("空清单（无 pipeline 也无 source/render）被至少一臂校验拒绝", () => {
    const result = runHubValidation({
      nonce: 4,
      dir: "/tmp/x",
      manifest: {
        plugin: { id: "session.empty", name: "empty" },
        kind: "session-composed",
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("清单需至少声明 pipeline 或 source/render 之一");
  });

  it("@file: 组件就绪位以请求附带的 componentJs 为准", () => {
    const manifest = {
      plugin: { id: "session.hyb", name: "hyb" },
      kind: "session-composed",
      source: { type: "messages" },
      render: { component: "@file:component.js", mount: "dock-panel" },
    };
    const without = runHubValidation({ nonce: 5, dir: "/tmp/x", manifest });
    expect(without.valid).toBe(false);
    expect(without.errors.some((e) => e.includes("代码组件未就绪"))).toBe(true);
    const withCode = runHubValidation({
      nonce: 6,
      dir: "/tmp/x",
      manifest,
      componentJs: "JishuPlugin.register('session.hyb', { version: 1, component: {} });",
    });
    expect(withCode.errors.some((e) => e.includes("代码组件未就绪"))).toBe(false);
  });
});
