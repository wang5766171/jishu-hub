// v0.7.4 需求1 A7 追加：模型档位声明（thinkingLevelMap）的表单往返。
import { describe, expect, it } from "vitest";
import {
  modelToValue,
  valueToModel,
  supportedThinkingLevels,
  thinkingLevelMapFromSupported,
  emptyModelValue,
} from "./model-types";

describe("supportedThinkingLevels", () => {
  it("defaults to off..high when no declaration exists", () => {
    expect(supportedThinkingLevels(undefined)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("null level is excluded (glm-5.3 cannot disable thinking)", () => {
    expect(supportedThinkingLevels({ off: null })).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("xhigh/max require explicit declaration", () => {
    expect(supportedThinkingLevels({ xhigh: "xhigh" })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});

describe("thinkingLevelMapFromSupported", () => {
  it("emits nothing for the default set (clean models.json)", () => {
    expect(
      thinkingLevelMapFromSupported(["off", "minimal", "low", "medium", "high"]),
    ).toBeUndefined();
  });

  it("declares off:null when off is unsupported", () => {
    expect(
      thinkingLevelMapFromSupported(["minimal", "low", "medium", "high"]),
    ).toEqual({ off: null });
  });

  it("declares extended levels explicitly", () => {
    expect(
      thinkingLevelMapFromSupported(["off", "minimal", "low", "medium", "high", "max"]),
    ).toEqual({ max: "max" });
  });
});

describe("model form round-trip", () => {
  it("preserves the off:null declaration through edit", () => {
    const entry = {
      id: "glm-5.3",
      name: "GLM-5.3",
      reasoning: true,
      thinkingLevelMap: { off: null },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const form = modelToValue(entry);
    expect(form.thinkingLevels).toEqual(["minimal", "low", "medium", "high"]);
    const back = valueToModel(form);
    expect(back.thinkingLevelMap).toEqual({ off: null });
  });

  it("writes no declaration for a fully default model", () => {
    const form = { ...emptyModelValue(), id: "m", reasoning: true };
    const back = valueToModel(form);
    expect(back.thinkingLevelMap).toBeUndefined();
  });
});
