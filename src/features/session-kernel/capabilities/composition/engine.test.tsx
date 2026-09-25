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
