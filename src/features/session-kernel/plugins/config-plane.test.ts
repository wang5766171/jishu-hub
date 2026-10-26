/** 需求12 P1：配置面纯函数——defaults 合并 / section 展平 / diff 校验（clamp/差异落盘语义）。 */
import { describe, expect, it } from "vitest";
import { diffAgainstDefaults, flattenSchema, mergeConfig } from "./config-plane";
import type { PluginConfigField } from "./config-plane";

const SCHEMA: PluginConfigField[] = [
  {
    key: "display",
    type: "section",
    label: "显示",
    fields: [
      { key: "inlineScalePct", type: "number", label: "初始缩放", default: 50, min: 10, max: 100, unit: "%" },
      { key: "themeFollow", type: "switch", label: "主题跟随", default: true },
    ],
  },
  { key: "pngScale", type: "number", label: "PNG 倍率", default: 2, min: 1, max: 4 },
  { key: "quietHours", type: "text", label: "静音时段", default: "", placeholder: "HH:mm-HH:mm" },
];

describe("config-plane", () => {
  it("merges user values over defaults (section flattened)", () => {
    const values = mergeConfig(SCHEMA, { inlineScalePct: 80 });
    expect(values).toEqual({ inlineScalePct: 80, themeFollow: true, pngScale: 2, quietHours: "" });
  });

  it("flattenSchema skips sections, keeps order", () => {
    const flat = flattenSchema(SCHEMA);
    expect(flat.map((f) => f.key)).toEqual(["inlineScalePct", "themeFollow", "pngScale", "quietHours"]);
  });

  it("diff keeps only explicit non-default keys", () => {
    const diff = diffAgainstDefaults(SCHEMA, { inlineScalePct: 80, themeFollow: true, pngScale: 2 });
    expect(diff).toEqual({ inlineScalePct: 80 });
  });

  it("diff clamps numbers to schema bounds", () => {
    const diff = diffAgainstDefaults(SCHEMA, { pngScale: 99 });
    expect(diff).toEqual({ pngScale: 4 });
  });

  it("diff drops invalid numbers instead of writing NaN", () => {
    const diff = diffAgainstDefaults(SCHEMA, { pngScale: Number.NaN });
    expect(diff).toEqual({});
  });
});
