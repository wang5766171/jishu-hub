import { describe, expect, it, vi } from "vitest";
import { sniffContentType } from "@/components/observability/tool-call-card/output-sniff";
import { buildComposedDescriptor } from "./engine";
import { rendererRegistry } from "../renderers/registry";
import { validateManifest, type SessionComposedManifest } from "../types";
import { matchToolResultRenderer } from "../../plugins/mounts/use-block-renderers";
import type { ToolResultRendererMount } from "../../plugins/types";
import * as registryMod from "../../plugins/registry";

/** 8a/8b/8c（v0.9.5 需求1，原需求26）：返回值适配——嗅探 / tool-result
 *  咨询点 / 渲染原语。 */
describe("8a：sniffContentType 内容嗅探", () => {
  it("SVG / HTML / JSON 表格 / 图片 / Markdown / 文本 六型判定", () => {
    expect(sniffContentType('<svg width="10"><rect/></svg>')).toBe("svg");
    expect(sniffContentType("<!DOCTYPE html><html><body>x</body></html>")).toBe("html");
    expect(sniffContentType('{"columns":["a"],"rows":[[1]]}')).toBe("table-json");
    expect(sniffContentType("data:image/png;base64,iVBORw0KGgo=")).toBe("image-data");
    expect(sniffContentType("# 标题\n\n- 项一\n- 项二\n\n```js\ncode\n```")).toBe("markdown");
    expect(sniffContentType("普通文本输出")).toBe("text");
    expect(sniffContentType("   ")).toBe("text");
  });

  it("非表格 JSON 与单命中 Markdown 不误判", () => {
    expect(sniffContentType('{"name":"x"}')).toBe("text");
    expect(sniffContentType("# 仅标题一项")).toBe("text");
  });
});

describe("8b：tool-result 源 + tool-output 挂载 + 咨询点", () => {
  it("配对矩阵：tool-result 源配 tool-output 合法，配 dock-panel 拒绝", () => {
    const manifest = {
      plugin: { id: "session.chart", name: "图表认领" },
      kind: "session-composed",
      source: { type: "tool-result", tool_name: "generate_chart" },
      render: { component: "render.table", mount: "tool-output" },
    } as SessionComposedManifest;
    expect(validateManifest(manifest, rendererRegistry)).toEqual([]);
    const bad = { ...manifest, render: { component: "render.table", mount: "dock-panel" } };
    expect(validateManifest(bad, rendererRegistry).some((e) => e.includes("不接受源类型"))).toBe(true);
  });

  it("装配产出 tool-result-renderer 挂载，咨询点按 tool_name 命中", () => {
    if (!rendererRegistry.get("render.table")) throw new Error("render.table 原语未注册");
    const manifest = {
      plugin: { id: "session.chart2", name: "图表认领2" },
      kind: "session-composed",
      source: { type: "tool-result", tool_name: "make_table" },
      render: { component: "render.table", mount: "tool-output" },
    } as SessionComposedManifest;
    const desc = buildComposedDescriptor(manifest);
    const mount = desc.mounts.find((m) => m.kind === "tool-result-renderer") as ToolResultRendererMount | undefined;
    expect(mount).toBeTruthy();
    expect(mount?.toolName).toBe("make_table");
    // 咨询点：描述符经 registry 消费——直接验证 match 语义（注册表注入后）。
    // 此处用 mount 的声明形状验证（registry 注入由 loader 层承接）。
    expect(mount?.component).toBeTruthy();
  });

  it("matchToolResultRenderer：toolName 精确与 toolPattern 正则", () => {
    const comp = () => null;
    // 模拟已启用插件的挂载注册（经 listSessionPlugins 快照）。
    const fakePlugin = {
      id: "session.matcher",
      displayNameKey: "",
      displayNameFallback: "matcher",
      descriptionKey: "",
      descriptionFallback: "",
      contractVersion: 1,
      source: "config" as const,
      permissions: [],
      mounts: [
        { kind: "tool-result-renderer", toolName: "gen_chart", component: comp },
        { kind: "tool-result-renderer", toolPattern: "query_.*", component: comp },
      ],
    };
    // listSessionPlugins 每次返回新数组——spyOn 注入测试插件快照。
    const spy = vi.spyOn(registryMod, "listSessionPlugins").mockReturnValue([fakePlugin as never]);
    try {
      expect(matchToolResultRenderer("gen_chart")?.component).toBe(comp);
      expect(matchToolResultRenderer("query_users")?.component).toBe(comp);
      expect(matchToolResultRenderer("other_tool")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
