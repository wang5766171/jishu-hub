/** 需求13 C4-slice1：流水线契约——模板展开/覆盖语义/校验。 */
import { describe, expect, it } from "vitest";
import { STAGE_TEMPLATES, resolveStages, validatePipeline } from "./contracts";

const VIDEO = {
  stages: [
    { template: "phase.discuss" as const },
    { name: "分镜设计", prompt: "按需求产出分镜表", skills: ["storyboard"] },
    { name: "素材整理" },
    { name: "视频生成", tools: ["video-render"], gate: "confirm" as const },
  ],
};

describe("resolveStages", () => {
  it("expands template stages with defaults and merges overrides", () => {
    const stages = resolveStages(VIDEO);
    expect(stages).toHaveLength(4);
    // 模板段：名称/技能/门禁取模板默认。
    expect(stages[0].name).toBe("需求讨论");
    expect(stages[0].skills).toEqual(STAGE_TEMPLATES["phase.discuss"].skills);
    expect(stages[0].gate).toBe("confirm");
    // 自定义段：声明覆盖，prompt 与模板基座拼接规则不适用（无模板）。
    expect(stages[1].name).toBe("分镜设计");
    expect(stages[1].skills).toEqual(["storyboard"]);
    expect(stages[1].gate).toBe("none");
    expect(stages[3].gate).toBe("confirm");
  });

  it("appends declaration prompt after template base", () => {
    const stages = resolveStages({ stages: [{ template: "phase.plan", prompt: "附加约定" }] });
    expect(stages[0].prompt).toContain("拆分");
    expect(stages[0].prompt.endsWith("附加约定")).toBe(true);
  });

  it("throws on unknown template", () => {
    expect(() => resolveStages({ stages: [{ template: "phase.nothing" as never }] })).toThrow(/未知模板/);
  });
});

describe("validatePipeline", () => {
  it("accepts the video example", () => {
    expect(validatePipeline(VIDEO)).toEqual([]);
  });

  it("rejects empty / duplicate keys / bad gate / blank stage", () => {
    expect(validatePipeline({ stages: [] })).toEqual(["[pipeline] 至少需要一个阶段"]);
    expect(validatePipeline({ stages: [{ key: "a", name: "x" }, { key: "a", name: "y" }] })[0]).toMatch(/key 重复/);
    expect(validatePipeline({ stages: [{ name: "x", gate: "maybe" as never }] })[0]).toMatch(/gate 非法/);
    expect(validatePipeline({ stages: [{}] })[0]).toMatch(/空阶段/);
  });
});
