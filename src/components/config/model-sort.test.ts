import { describe, expect, it } from "vitest";
import { byVersionDesc, versionSegments } from "./model-sort";

describe("versionSegments", () => {
  it("extracts dotted and discrete numbers", () => {
    expect(versionSegments("glm-5.2-flash")).toEqual([5, 2]);
    expect(versionSegments("glm-5.2-flash-250")).toEqual([5, 2, 250]);
    expect(versionSegments("gpt-5.6-terra")).toEqual([5, 6]);
    expect(versionSegments("no-numbers")).toEqual([]);
  });
});

describe("byVersionDesc", () => {
  it("sorts newer versions first", () => {
    const list = ["glm-5.1", "glm-5.3", "glm-5.2"];
    list.sort(byVersionDesc);
    expect(list).toEqual(["glm-5.3", "glm-5.2", "glm-5.1"]);
  });

  it("same version falls back to id reverse-lexicographic (stable)", () => {
    const list = ["gpt-5.6-luna", "gpt-5.6-terra"];
    list.sort(byVersionDesc);
    expect(list).toEqual(["gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  it("non-numeric ids sort last", () => {
    const list = ["custom-model", "glm-5.3", "another"];
    list.sort(byVersionDesc);
    expect(list[0]).toBe("glm-5.3");
  });

  it("handles multi-segment versions", () => {
    const list = ["glm-5.2", "glm-5.2-flash-250", "glm-5.3"];
    list.sort(byVersionDesc);
    expect(list).toEqual(["glm-5.3", "glm-5.2-flash-250", "glm-5.2"]);
  });
});
