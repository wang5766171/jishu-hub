import i18n from "@/i18n";
import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphEditor } from "./graph-editor";
import type { GraphSnapshot, NodeRun, NodeRunStatus } from "./use-task-graph";

/**
 * F2（设计 §5 批 F2）回归测试：
 *   - B-3 位置单一来源：拖拽中的节点位置不被 savedPositions 旧值覆盖；
 *   - F2-2 引用稳定 diff：label/style/position 全等时节点对象引用不变（空载零更新）。
 *
 * jsdom 无 Worker → 布局走同步 computeLayout fallback 路径；worker pending 路径
 * （F2-5 新节点暂不入画布）在 jsdom 不可达，由真实环境手测覆盖。
 */

interface HarnessNode {
  id: string;
  position: { x: number; y: number };
  data: { label: string };
}

const flowHarness = vi.hoisted(() => ({
  setNodes: null as React.Dispatch<React.SetStateAction<HarnessNode[]>> | null,
  currentNodes: [] as HarnessNode[],
}));

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({
    nodes,
    children,
  }: {
    nodes: HarnessNode[];
    children: React.ReactNode;
  }) => {
    flowHarness.currentNodes = nodes;
    return <div>{children}</div>;
  },
  MiniMap: () => null,
  Controls: () => null,
  Background: () => null,
  useNodesState: (initial: unknown[]) => {
    const [nodes, setNodes] = React.useState(initial);
    flowHarness.setNodes = setNodes as typeof flowHarness.setNodes;
    return [nodes, setNodes, vi.fn()];
  },
  useEdgesState: (initial: unknown[]) => {
    const [edges, setEdges] = React.useState(initial);
    return [edges, setEdges, vi.fn()];
  },
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
  MarkerType: { ArrowClosed: "arrowclosed" },
}));

vi.mock("dagre", () => {
  class Graph {
    setDefaultEdgeLabel = vi.fn();
    setGraph = vi.fn();
    setNode = vi.fn();
    setEdge = vi.fn();
    node = vi.fn(() => ({ x: 120, y: 80 }));
  }
  return { default: { graphlib: { Graph }, layout: vi.fn() } };
});

const snapshot: GraphSnapshot = {
  nodes: [
    {
      node_id: "goal",
      parent_id: null,
      title: "Goal",
      description: null,
      node_kind: "goal",
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
    },
    {
      node_id: "step_a",
      parent_id: "goal",
      title: "Step A",
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
    },
  ],
  edges: [],
};

function makeNodeRun(nodeId: string, status: NodeRunStatus): NodeRun {
  return {
    node_run_id: `nr_${nodeId}`,
    run_id: "run_1",
    node_id: nodeId,
    status,
    revision_id: "rev_1",
    started_at: null,
    finished_at: null,
    attempt_count: 0,
    error: null,
  };
}

function nodeById(id: string): HarnessNode | undefined {
  return flowHarness.currentNodes.find((node) => node.id === id);
}

describe("graph editor F2 position stability", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(() => {
    localStorage.clear();
    flowHarness.currentNodes = [];
    flowHarness.setNodes = null;
  });

  it("拖拽中的节点位置不被重建覆盖（savedPositions 不再凌驾当前位置，B-3）", async () => {
    // 拖拽前持久化的旧位置——若派生 effect 回读它覆盖当前位置，节点会弹回 {10,10}。
    localStorage.setItem(
      "jishu:task-node-positions:g1",
      JSON.stringify({ goal: { x: 10, y: 10 } }),
    );
    const { rerender } = render(
      <GraphEditor
        snapshot={snapshot}
        graphId="g1"
        nodeRuns={{ goal: makeNodeRun("goal", "ready") }}
      />,
    );
    // 初次挂载：current 为空，savedPositions 正常生效（重进任务布局还原）。
    await waitFor(() => expect(nodeById("goal")?.position).toEqual({ x: 10, y: 10 }));

    // 模拟拖拽：受控模式下 ReactFlow 经 onNodesChange 把拖动后的位置写进 nodes state
    // （onNodeDragStop 尚未触发，localStorage 仍是旧值）。
    act(() => {
      flowHarness.setNodes?.((current) =>
        current.map((node) =>
          node.id === "goal" ? { ...node, position: { x: 555, y: 333 } } : node,
        ),
      );
    });
    expect(nodeById("goal")?.position).toEqual({ x: 555, y: 333 });

    // 轮询带来 nodeRuns 变化（ready → running）→ 派生 effect 重跑。
    rerender(
      <GraphEditor
        snapshot={snapshot}
        graphId="g1"
        nodeRuns={{ goal: makeNodeRun("goal", "running") }}
      />,
    );

    // label 确实刷新了（running 状态文本进入 label）……
    await waitFor(() => {
      expect(nodeById("goal")?.data.label).toContain(
        i18n.t("tasks.workbench.status.running"),
      );
    });
    // ……但位置保持拖拽后的值，不被 localStorage 旧值覆盖（不回弹）。
    expect(nodeById("goal")?.position).toEqual({ x: 555, y: 333 });
  });

  it("nodeRuns 同值刷新时节点对象引用不变（label/style/position diff 全等，空载零更新）", async () => {
    const { rerender } = render(
      <GraphEditor
        snapshot={snapshot}
        graphId="g1"
        nodeRuns={{ goal: makeNodeRun("goal", "running") }}
      />,
    );
    await waitFor(() => expect(flowHarness.currentNodes.length).toBe(2));
    const before = flowHarness.currentNodes;

    // 轮询同值场景：即便上游引用变化但内容同值（F1 mergeNodeRunsStable 的下游保险），
    // 画布也不应重建任何节点对象。
    rerender(
      <GraphEditor
        snapshot={snapshot}
        graphId="g1"
        nodeRuns={{ goal: { ...makeNodeRun("goal", "running") } }}
      />,
    );

    await waitFor(() => expect(flowHarness.currentNodes.length).toBe(2));
    // 数组引用不变 → ReactFlow 零调和。
    expect(flowHarness.currentNodes).toBe(before);
  });
});
