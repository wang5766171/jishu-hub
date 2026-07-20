import { describe, it, expect } from "vitest";
import {
  compareSemver,
  isVersionNewer,
  nodeVersionSatisfies,
  MIN_NODE_VERSION,
} from "./version-constants";

describe("compareSemver", () => {
  it("按 major/minor/patch 数值比较", () => {
    expect(compareSemver("22.14.0", "22.19.0")).toBeLessThan(0);
    expect(compareSemver("22.19.0", "22.19.0")).toBe(0);
    expect(compareSemver("23.0.0", "22.19.0")).toBeGreaterThan(0);
    expect(compareSemver("22.19.1", "22.19.0")).toBeGreaterThan(0);
    expect(compareSemver("22.19.0", "22.20.0")).toBeLessThan(0);
  });

  it("兼容 v 前缀", () => {
    expect(compareSemver("v22.19.0", "22.19.0")).toBe(0);
    expect(compareSemver("v22.14.0", "v22.19.0")).toBeLessThan(0);
  });

  it("预发布后缀只取前三段", () => {
    expect(compareSemver("22.19.0-nightly.1", "22.19.0")).toBe(0);
    expect(compareSemver("22.14.0-rc.2", "22.19.0")).toBeLessThan(0);
  });

  it("无法解析返回 NaN", () => {
    expect(compareSemver("not a version", "22.19.0")).toBeNaN();
    expect(compareSemver("22.19.0", "")).toBeNaN();
    expect(compareSemver("abc", "def")).toBeNaN();
  });
});

describe("isVersionNewer", () => {
  it("识别 Jishu Agent 自研版本的升级", () => {
    expect(isVersionNewer("0.80.2-8", "0.80.10-8")).toBe(true);
    expect(isVersionNewer("0.80.10-7", "0.80.10-8")).toBe(true);
    expect(isVersionNewer("0.80.10-8", "0.80.10-8")).toBe(false);
    expect(isVersionNewer("0.80.11-8", "0.80.10-8")).toBe(false);
    expect(isVersionNewer("unknown", "0.80.10-8")).toBe(false);
  });
});

describe("nodeVersionSatisfies", () => {
  it("低于最低版本返回 false", () => {
    expect(nodeVersionSatisfies("22.14.0", MIN_NODE_VERSION)).toBe(false);
    expect(nodeVersionSatisfies("22.18.99", MIN_NODE_VERSION)).toBe(false);
  });

  it("等于最低版本返回 true", () => {
    expect(nodeVersionSatisfies("22.19.0", MIN_NODE_VERSION)).toBe(true);
  });

  it("高于最低版本返回 true", () => {
    expect(nodeVersionSatisfies("23.0.0", MIN_NODE_VERSION)).toBe(true);
    expect(nodeVersionSatisfies("22.19.1", MIN_NODE_VERSION)).toBe(true);
  });

  it("null / 空串返回 false", () => {
    expect(nodeVersionSatisfies(null, MIN_NODE_VERSION)).toBe(false);
    expect(nodeVersionSatisfies("", MIN_NODE_VERSION)).toBe(false);
  });

  it("垃圾串保守返回 false", () => {
    expect(nodeVersionSatisfies("garbage", MIN_NODE_VERSION)).toBe(false);
  });

  it("兼容 v 前缀", () => {
    expect(nodeVersionSatisfies("v22.14.0", MIN_NODE_VERSION)).toBe(false);
    expect(nodeVersionSatisfies("v22.19.0", MIN_NODE_VERSION)).toBe(true);
  });
});
