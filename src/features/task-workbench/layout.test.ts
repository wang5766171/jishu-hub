import { describe, it, expect } from "vitest";
import { computeLayout, computeLayoutWithOptions } from "./layout";

describe("computeLayout", () => {
  it("returns an empty result for an empty graph", () => {
    expect(computeLayout({ nodes: [], edges: [] })).toEqual({});
  });

  it("lays out every node", () => {
    const result = computeLayout({
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    });
    expect(Object.keys(result).sort()).toEqual(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) {
      expect(typeof result[id].x).toBe("number");
      expect(typeof result[id].y).toBe("number");
    }
  });

  it("places a left-to-right chain with strictly increasing x", () => {
    const result = computeLayout({
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    });
    expect(result.a.x).toBeLessThan(result.b.x);
    expect(result.b.x).toBeLessThan(result.c.x);
  });

  it("places a top-to-bottom chain with strictly increasing y", () => {
    const result = computeLayoutWithOptions(
      {
        nodes: [{ id: "a" }, { id: "b" }],
        edges: [{ source: "a", target: "b" }],
      },
      { rankdir: "TB", ranksep: 150, nodesep: 90, edgesep: 35, marginx: 40, marginy: 40 },
    );
    expect(result.a.y).toBeLessThan(result.b.y);
  });

  it("is deterministic for identical inputs", () => {
    const graph = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
      ],
    };
    expect(computeLayout(graph)).toEqual(computeLayout(graph));
  });
});
