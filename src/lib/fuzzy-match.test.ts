import { describe, it, expect } from "vitest";
import { fuzzyScore, fuzzyRank } from "./fuzzy-match";

describe("fuzzyScore", () => {
  it("子序列命中返回非空分数，未命中返回 null", () => {
    expect(fuzzyScore("pkg", "package.json")).not.toBeNull();
    expect(fuzzyScore("xyz", "package.json")).toBeNull();
  });

  it("大小写不敏感", () => {
    expect(fuzzyScore("MF", "Makefile")).not.toBeNull();
  });

  it("前缀/连续命中得分高于分散命中", () => {
    const contiguous = fuzzyScore("pack", "package.json")!;
    const scattered = fuzzyScore("pkg", "package.json")!;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it("空查询得 0 分（全部可显示）", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("fuzzyRank", () => {
  const files = [
    "src/main.rs",
    "src/models/user.rs",
    "src/models/order.rs",
    "README.md",
    "package.json",
  ];

  it("空查询返回前 limit 项保持原序", () => {
    const ranked = fuzzyRank("", files, (f) => f, 3);
    expect(ranked.map((r) => r.item)).toEqual(["src/main.rs", "src/models/user.rs", "src/models/order.rs"]);
  });

  it("按分数排序并截断", () => {
    const ranked = fuzzyRank("user", files, (f) => f, 2);
    expect(ranked[0].item).toBe("src/models/user.rs");
    expect(ranked.length).toBeLessThanOrEqual(2);
  });

  it("无命中返回空数组", () => {
    expect(fuzzyRank("zzzz", files, (f) => f)).toEqual([]);
  });
});
