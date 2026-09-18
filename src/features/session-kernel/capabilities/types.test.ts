import { describe, expect, it } from "vitest";
import { validateManifest, type RendererRegistration, type SessionComposedManifest } from "./types";

const renderers = {
  get: (key: string): RendererRegistration | undefined =>
    key === "render.divider" || key === "render.list"
      ? { key, component: () => null }
      : undefined,
};

function manifest(overrides: {
  source?: Partial<SessionComposedManifest["source"]>;
  mount?: string;
}): SessionComposedManifest {
  const source = overrides.source ?? { type: "block-type", blockTypes: ["phase_divider"] };
  return {
    plugin: { id: "test.plugin", name: "测试" },
    kind: "session-composed",
    source: source as SessionComposedManifest["source"],
    render: { component: "render.divider", mount: overrides.mount ?? "block-renderer" },
  };
}

describe("validateManifest（source×mount 配对矩阵，测试期修复23 契约收口）", () => {
  it("合法配对通过（六个内置清单形状）", () => {
    // mermaid-render：code-block + block-renderer
    expect(
      validateManifest(manifest({ source: { type: "code-block", languages: ["mermaid"] } }), renderers),
    ).toEqual([]);
    // phase-divider：block-type + block-renderer
    expect(validateManifest(manifest({}), renderers)).toEqual([]);
    // outline：turns + dock-panel
    expect(
      validateManifest(manifest({ source: { type: "turns" }, mount: "dock-panel" }), renderers),
    ).toEqual([]);
    // tool-stats：messages + dock-panel
    expect(
      validateManifest(manifest({ source: { type: "messages" }, mount: "dock-panel" }), renderers),
    ).toEqual([]);
    // navigation：turns + rail-widget
    expect(
      validateManifest(manifest({ source: { type: "turns" }, mount: "rail-widget" }), renderers),
    ).toEqual([]);
    // desktop-notify：signal + event-hook
    expect(
      validateManifest(manifest({ source: { type: "signal" }, mount: "event-hook" }), renderers),
    ).toEqual([]);
  });

  it("数据面源配 block-renderer 拒绝（turns 劫持一切代码块的同源洞）", () => {
    const errors = validateManifest(
      manifest({ source: { type: "turns", blockTypes: undefined }, mount: "block-renderer" }),
      renderers,
    );
    expect(errors.some((e) => e.includes("block-renderer 不接受源类型 turns"))).toBe(true);
  });

  it("block-type 源配数据面/事件挂载拒绝（静默无意义载荷洞）", () => {
    for (const mount of ["dock-panel", "rail-widget", "composer-trailing", "event-hook"]) {
      const errors = validateManifest(manifest({ mount }), renderers);
      expect(errors.some((e) => e.includes(`mount ${mount} 不接受源类型 block-type`))).toBe(true);
    }
  });

  it("signal 源配渲染挂载拒绝", () => {
    const errors = validateManifest(
      manifest({ source: { type: "signal" }, mount: "block-renderer" }),
      renderers,
    );
    expect(errors.some((e) => e.includes("block-renderer 不接受源类型 signal"))).toBe(true);
  });

  it("未知 mount 拒绝", () => {
    const errors = validateManifest(manifest({ mount: "nowhere" }), renderers);
    expect(errors.some((e) => e.includes("mount 非法"))).toBe(true);
  });

  it("源域字段互斥：block-type 不得声明 languages / code-block 不得声明 blockTypes", () => {
    expect(
      validateManifest(
        manifest({ source: { type: "block-type", blockTypes: ["phase_divider"], languages: ["mermaid"] } }),
        renderers,
      ).some((e) => e.includes("不得声明 languages")),
    ).toBe(true);
    expect(
      validateManifest(
        manifest({ source: { type: "code-block", languages: ["mermaid"], blockTypes: ["phase_divider"] } }),
        renderers,
      ).some((e) => e.includes("不得声明 blockTypes")),
    ).toBe(true);
  });

  it("源域显式格式必填：block-type 需 blockTypes / code-block 需 languages", () => {
    expect(
      validateManifest(manifest({ source: { type: "block-type" } }), renderers).some((e) =>
        e.includes("block-type 需声明 blockTypes"),
      ),
    ).toBe(true);
    expect(
      validateManifest(manifest({ source: { type: "code-block", languages: [] } }), renderers).some((e) =>
        e.includes("code-block 需声明 languages"),
      ),
    ).toBe(true);
  });
});
