import { describe, it, expect } from "vitest";
import { computeStepOrder } from "./compute-step-order";
import type { GraphSnapshot } from "@/features/task-instance/graph/use-task-graph";

function mkSnapshot(nodes: string[], edges: [string, string][]): GraphSnapshot {
  return {
    nodes: nodes.map((id) => ({
      node_id: id,
      parent_id: null,
      title: id,
      description: null,
      node_kind: "executable",
      input_contract: {},
      output_contract: {},
      role_requirement: null,
      capability_requirements: [],
      agent_assignment_constraint: null,
      policy: {},
      metadata: {},
      executable_payload: null,
      loop_config: null,
      approval_gate_config: null,
    })),
    edges: edges.map(([source, target], i) => ({
      edge_id: `e${i}`,
      source_node_id: source,
      target_node_id: target,
      kind: "control_dependency" as const,
    })),
  };
}

describe("computeStepOrder", () => {
  it("returns empty for null/undefined snapshot", () => {
    expect(computeStepOrder(null)).toEqual([]);
    expect(computeStepOrder(undefined)).toEqual([]);
  });

  it("returns empty for snapshot with no nodes", () => {
    expect(computeStepOrder(mkSnapshot([], []))).toEqual([]);
  });

  it("handles single node with no edges", () => {
    expect(computeStepOrder(mkSnapshot(["a"], []))).toEqual(["a"]);
  });

  it("orders a linear chain a→b→c correctly", () => {
    const snap = mkSnapshot(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
    expect(computeStepOrder(snap)).toEqual(["a", "b", "c"]);
  });

  it("orders a diamond: a→{b,c}→d", () => {
    const snap = mkSnapshot(["a", "b", "c", "d"], [
      ["a", "b"],
      ["a", "c"],
      ["b", "d"],
      ["c", "d"],
    ]);
    const result = computeStepOrder(snap);
    expect(result[0]).toBe("a");
    expect(result[3]).toBe("d");
    // b 和 c 同层，按 node_id 排序：b 在 c 前
    expect(result.indexOf("b")).toBeLessThan(result.indexOf("c"));
  });

  it("is stable: same input produces same output across multiple calls", () => {
    const snap = mkSnapshot(["x", "y", "z", "w"], [
      ["x", "y"],
      ["x", "z"],
      ["y", "w"],
    ]);
    const results = Array.from({ length: 10 }, () => computeStepOrder(snap));
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0]);
    }
  });

  it("appends cycle nodes to the end without throwing", () => {
    // a→b→c→b 形成环（b↔c）；a 无环
    const snap = mkSnapshot(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "b"]]);
    const result = computeStepOrder(snap);
    // a 先出（入度 0）
    expect(result[0]).toBe("a");
    // b、c 在环中，追加到末尾，按 node_id 排序
    expect(result.slice(1).sort()).toEqual(["b", "c"]);
    expect(result).toHaveLength(3);
  });

  it("appends isolated nodes (no edges) to the end of their layer", () => {
    const snap = mkSnapshot(["a", "b", "isolated"], [["a", "b"]]);
    const result = computeStepOrder(snap);
    // isolated 入度 0，与 a 同层，按 node_id：a < isolated
    expect(result).toEqual(["a", "isolated", "b"]);
  });

  it("respects layout positions for same-layer ordering", () => {
    // 两个独立节点，布局坐标决定顺序：y 小的在前
    const snap = mkSnapshot(["top", "bottom"], []);
    const layout = {
      top: { x: 0, y: 10 },
      bottom: { x: 0, y: 100 },
    };
    const result = computeStepOrder(snap, layout);
    expect(result).toEqual(["top", "bottom"]);
  });

  it("ignores edges pointing to non-existent nodes", () => {
    const snap = mkSnapshot(["a", "b"], [["a", "ghost"], ["ghost", "b"]]);
    // ghost 不在 nodes 里，这两条边被忽略
    const result = computeStepOrder(snap);
    expect(result.sort()).toEqual(["a", "b"]);
  });

  it("handles a complex DAG with multiple layers", () => {
    //   a → b → d
    //   a → c → d
    //   e → f
    const snap = mkSnapshot(["a", "b", "c", "d", "e", "f"], [
      ["a", "b"],
      ["a", "c"],
      ["b", "d"],
      ["c", "d"],
      ["e", "f"],
    ]);
    const result = computeStepOrder(snap);
    // 层 0: a, e（同层，按 id）
    expect(result.slice(0, 2).sort()).toEqual(["a", "e"]);
    // 层 1: b, c, f
    expect(result.slice(2, 5).sort()).toEqual(["b", "c", "f"]);
    // 层 2: d
    expect(result[5]).toBe("d");
    // a 在 b/c 前，b/c 在 d 前，e 在 f 前
    expect(result.indexOf("a")).toBeLessThan(result.indexOf("b"));
    expect(result.indexOf("b")).toBeLessThan(result.indexOf("d"));
    expect(result.indexOf("e")).toBeLessThan(result.indexOf("f"));
  });
});
