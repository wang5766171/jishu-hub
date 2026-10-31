import { describe, expect, it, beforeAll } from "vitest";
import { buildComposedDescriptor } from "./engine";
import { rendererRegistry } from "../renderers/registry";
import { validateManifest, type SessionComposedManifest } from "../types";
import type { PipelineDeclaration } from "../pipeline/contracts";

/** 1a（v0.9.5 需求1，原需求26）：pipeline 与渲染两臂合并装配——去早退。
 *  回归夹具对齐 src-tauri/resources/composed-plugins/video-maker.toml（纯
 *  流水线清单，无 source/render）。 */
const pipeline: PipelineDeclaration = {
  stages: [
    { name: "讨论", template: "phase.discuss" },
    { name: "执行", prompt: "按计划执行", gate: "confirm" },
  ],
};

function baseManifest(): SessionComposedManifest {
  return {
    plugin: { id: "test.plugin", name: "测试" },
    kind: "session-composed",
    source: { type: "messages" },
    render: { component: "render.list", mount: "dock-panel" },
  };
}

describe("1a：engine 去早退 + source/render 可选（两臂合并装配）", () => {
  beforeAll(() => {
    // engine 用真实注册表单例，测试内注册占位组件。
    if (!rendererRegistry.get("render.list")) {
      rendererRegistry.register({ key: "render.list", component: () => null });
    }
  });
  it("1a-1 纯流水线清单（video-maker 形态）：validateManifest 不报 source/render 缺失，描述符透出 pipeline 且 mounts 为空", () => {
    const manifest: SessionComposedManifest = {
      plugin: { id: "session.video-maker", name: "视频制作" },
      kind: "session-composed",
      pipeline,
    };
    expect(validateManifest(manifest, { get: () => undefined })).toEqual([]);
    const desc = buildComposedDescriptor(manifest);
    expect(desc.pipeline).toEqual(pipeline);
    expect(desc.mounts).toEqual([]);
  });

  it("1a-2 pipeline + source/render 同时声明：流水线阶段 AND 渲染面板同时生效（不是只出流水线）", () => {
    const manifest: SessionComposedManifest = { ...baseManifest(), pipeline };
    const desc = buildComposedDescriptor(manifest);
    expect(desc.pipeline).toEqual(pipeline);
    expect(desc.mounts).toHaveLength(1);
    expect(desc.mounts[0]).toMatchObject({ kind: "dock-panel" });
  });

  it("1a-3 纯渲染清单（无 pipeline）：渲染正常，描述符 pipeline 为 undefined", () => {
    const desc = buildComposedDescriptor(baseManifest());
    expect(desc.pipeline).toBeUndefined();
    expect(desc.mounts).toHaveLength(1);
  });

  it("1a-4 空清单（无 pipeline 也无 source/render）：校验拒绝（至少一臂）", () => {
    const manifest = {
      plugin: { id: "test.empty", name: "空" },
      kind: "session-composed",
    } as SessionComposedManifest;
    const errors = validateManifest(manifest, { get: () => undefined });
    expect(errors).toContain("清单需至少声明 pipeline 或 source/render 之一");
    expect(() => buildComposedDescriptor(manifest)).toThrow("至少声明 pipeline 或 source/render");
  });

  it("残缺渲染臂（只声明 source 无 render）：报具体缺失字段而非静默通过", () => {
    const manifest = {
      plugin: { id: "test.half", name: "半拉" },
      kind: "session-composed",
      source: { type: "messages" },
    } as SessionComposedManifest;
    const errors = validateManifest(manifest, { get: () => undefined });
    expect(errors.some((e) => e.includes("[render]"))).toBe(true);
  });
});

describe("需求14 M1：block-renderer 解禁——fileComponent 透传与 fallback 消费", () => {
  beforeAll(() => {
    if (!rendererRegistry.get("render.mono-text")) {
      rendererRegistry.register({ key: "render.mono-text", component: () => null });
    }
  });

  function blockRendererManifest(fallback?: string): SessionComposedManifest {
    return {
      plugin: { id: "test.hy", name: "混合渲染" },
      kind: "session-composed",
      source: { type: "code-block", languages: ["echarts"] },
      render: { component: "@file:component.js", mount: "block-renderer", ...(fallback ? { fallback } : {}) },
    };
  }

  it("code 臂透传 fileComponent——混合组件收统一 payload {kind:'code-block', language, code}（R1 契约）", async () => {
    const { render } = await import("@testing-library/react");
    const { createElement } = await import("react");
    const seen: unknown[] = [];
    const HybridComp = (props: Record<string, unknown>) => {
      seen.push(props.payload);
      return createElement("span", null, "hybrid-out");
    };
    const desc = buildComposedDescriptor(blockRendererManifest(), {
      component: HybridComp as never,
    });
    const mount = desc.mounts.find((m) => m.kind === "block-renderer") as unknown as {
      matching: string;
      Component: (props: { code: string; language: string }) => React.ReactElement;
    };
    expect(mount.matching).toBe("code");
    const { container } = render(createElement(mount.Component, { code: "{a:1}", language: "echarts" }));
    expect(container.textContent).toBe("hybrid-out");
    expect(seen[seen.length - 1]).toMatchObject({ kind: "code-block", language: "echarts", code: "{a:1}" });
  });

  it("block-type 臂同样透传 fileComponent（payload {kind:'block', blockType, block}）", async () => {
    const { render } = await import("@testing-library/react");
    const { createElement } = await import("react");
    const seen: unknown[] = [];
    const HybridComp = (props: Record<string, unknown>) => {
      seen.push(props.payload);
      return createElement("span", null, "hybrid-block");
    };
    const manifest: SessionComposedManifest = {
      plugin: { id: "test.hy2", name: "混合块渲染" },
      kind: "session-composed",
      source: { type: "block-type", blockTypes: ["phase_divider"] },
      render: { component: "@file:component.js", mount: "block-renderer" },
    };
    const desc = buildComposedDescriptor(manifest, { component: HybridComp as never });
    const mount = desc.mounts.find((m) => m.kind === "block-renderer") as unknown as {
      matching: string;
      BlockComponent: (props: { block: unknown }) => React.ReactElement;
    };
    expect(mount.matching).toBe("block-type");
    render(createElement(mount.BlockComponent, { block: { type: "phase_divider", title: "x" } }));
    expect(seen[seen.length - 1]).toMatchObject({ kind: "block", blockType: "phase_divider" });
  });

  it("B1 fallback 消费：代码组件崩溃 → 渲染声明的兜底键组件（同 payload，源码不空白）", async () => {
    const { render } = await import("@testing-library/react");
    const { createElement } = await import("react");
    rendererRegistry.register({
      key: "render.test-fb",
      component: ({ payload }: { payload: { kind?: string; code?: string } }) =>
        createElement("pre", null, `fallback:${payload.code ?? ""}`),
    });
    function Boom(): null {
      throw new Error("组件炸了");
    }
    const desc = buildComposedDescriptor(blockRendererManifest("render.test-fb"), {
      component: Boom as never,
    });
    const mount = desc.mounts.find((m) => m.kind === "block-renderer") as unknown as {
      Component: (props: { code: string; language: string }) => React.ReactElement;
    };
    const { container } = render(createElement(mount.Component, { code: "ABC", language: "echarts" }));
    expect(container.textContent).toBe("fallback:ABC");
  });
});

describe("需求14 M4：descriptor 透传 [plugin].icon（B15）", () => {
  it("声明 icon 时描述符携带（能力中心/插件中心统一图标来源）", () => {
    const manifest = {
      ...baseManifest(),
      plugin: { id: "test.iconic", name: "图标件", icon: "sparkles" },
    } as SessionComposedManifest;
    const desc = buildComposedDescriptor(manifest);
    expect(desc.icon).toBe("sparkles");
    // 未声明 → undefined（消费侧走内置 id 映射/默认图标兜底）。
    const bare = buildComposedDescriptor(baseManifest());
    expect(bare.icon).toBeUndefined();
  });
});

describe("需求14 M2：主题描述符透传（app-theme 无会话挂载臂）", () => {
  it("descriptor 携带 theme（base 缺省归一 dark）且 mounts 为空", () => {
    const manifest = {
      plugin: { id: "session.theme-test", name: "主题" },
      kind: "session-composed",
      theme: { css: "@file:theme.css", preview: ["#111", "#eee"] },
      render: { component: "", mount: "app-theme" },
    } as unknown as SessionComposedManifest;
    const desc = buildComposedDescriptor(manifest);
    expect(desc.theme).toMatchObject({ css: "@file:theme.css", base: "dark", preview: ["#111", "#eee"] });
    expect(desc.mounts).toEqual([]);
  });
});
