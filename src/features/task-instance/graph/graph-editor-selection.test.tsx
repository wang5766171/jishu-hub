import i18n from "@/i18n";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphEditor } from "./graph-editor";
import type { GraphSnapshot } from "./use-task-graph";

const flowHarness = vi.hoisted(() => ({
  selectionEffectCount: 0,
}));

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({
    nodes,
    edges,
    children,
    onNodeClick,
    onEdgeClick,
    onPaneClick,
  }: {
    nodes: Array<{ id: string; selected?: boolean }>;
    edges: Array<{
      id: string;
      label?: string;
      selected?: boolean;
      markerEnd?: { type?: string };
    }>;
    children: React.ReactNode;
    onNodeClick?: (event: unknown, node: { id: string; selected?: boolean }) => void;
    onEdgeClick?: (event: unknown, edge: { id: string; selected?: boolean }) => void;
    onPaneClick?: () => void;
  }) => {
    React.useEffect(() => {
      if (nodes.length === 0) return;
      flowHarness.selectionEffectCount += 1;
      if (flowHarness.selectionEffectCount > 20) {
        throw new Error("selection feedback loop");
      }
    }, [edges, nodes]);

    return (
      <div>
        <button type="button" data-testid="flow-pane" onClick={onPaneClick}>
          pane
        </button>
        {nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            data-testid={`flow-node-${node.id}`}
            onClick={() => onNodeClick?.({}, node)}
          >
            {JSON.stringify(node)}
          </button>
        ))}
        {edges.map((edge) => (
          <button
            key={edge.id}
            type="button"
            data-testid={`flow-edge-${edge.id}`}
            onClick={() => onEdgeClick?.({}, edge)}
          >
            {JSON.stringify(edge)}
          </button>
        ))}
        <output data-testid="flow-nodes">{JSON.stringify(nodes)}</output>
        {children}
      </div>
    );
  },
  MiniMap: () => null,
  Controls: () => null,
  Background: () => null,
  useNodesState: (initial: unknown[]) => {
    const [nodes, setNodes] = React.useState(initial);
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
  const setNode = vi.fn();
  const setEdge = vi.fn();
  const setGraph = vi.fn();
  const setDefaultEdgeLabel = vi.fn();
  const layout = vi.fn();
  const nodeFn = vi.fn((id: string) => {
    if (id === "implementation") return { x: 350, y: 80 };
    return { x: 100, y: 80 };
  });
  class Graph {
    setDefaultEdgeLabel = setDefaultEdgeLabel;
    setGraph = setGraph;
    setNode = setNode;
    setEdge = setEdge;
    layout = layout;
    node = nodeFn;
  }
  const dagreMock = {
    graphlib: { Graph },
    layout,
  };
  return { default: dagreMock };
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
  ],
  edges: [],
};

const snapshotWithEdge: GraphSnapshot = {
  nodes: [
    snapshot.nodes[0],
    {
      ...snapshot.nodes[0],
      node_id: "implementation",
      title: "Implementation",
      node_kind: "executable",
    },
  ],
  edges: [
    {
      edge_id: "edge_1",
      source_node_id: "goal",
      target_node_id: "implementation",
      kind: "control_dependency",
    },
  ],
};

describe("graph editor controlled selection", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(() => {
    flowHarness.selectionEffectCount = 0;
  });

  it("spreads nodes by deterministic layout", async () => {
    render(<GraphEditor snapshot={snapshotWithEdge} />);

    await waitFor(() => {
      const data = screen.getByTestId("flow-nodes").textContent ?? "";
      expect(data).toContain('"id":"goal"');
      expect(data).toContain('"id":"implementation"');
      const positions = JSON.parse(data) as Array<{
        id: string;
        position: { x: number; y: number };
      }>;
      const goal = positions.find((n) => n.id === "goal");
      const implementation = positions.find((n) => n.id === "implementation");
      expect(goal).toBeDefined();
      expect(implementation).toBeDefined();
      expect(Math.abs((goal?.position.x ?? 0) - (implementation?.position.x ?? 0))).toBeGreaterThan(0);
    });
  });

  it("localizes dependency labels and renders a target arrow", async () => {
    render(<GraphEditor snapshot={snapshotWithEdge} />);

    const edge = await screen.findByTestId("flow-edge-edge_1");
    expect(edge).toHaveTextContent("控制依赖");
    expect(edge).toHaveTextContent('"type":"arrowclosed"');
  });

  it("selects a dependency edge and removes it from the edge panel", async () => {
    const applyCommands = vi.fn().mockResolvedValue(undefined);
    render(
      <GraphEditor
        snapshot={snapshotWithEdge}
        applyCommands={applyCommands}
      />,
    );

    fireEvent.click(await screen.findByTestId("flow-edge-edge_1"));
    fireEvent.click(await screen.findByRole("button", { name: "删除依赖" }));

    expect(applyCommands).toHaveBeenCalledWith([
      expect.objectContaining({
        op: "remove_edge",
        edge_id: "edge_1",
      }),
    ]);
  });

  it("does not force React Flow node selection from external inspector state", async () => {
    const { rerender } = render(
      <GraphEditor
        snapshot={snapshot}
        selectedNodeId="goal"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("flow-nodes")).toHaveTextContent('"id":"goal"');
    });
    expect(screen.getByTestId("flow-nodes")).not.toHaveTextContent('"selected"');

    rerender(
      <GraphEditor
        snapshot={snapshot}
        selectedNodeId={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("flow-nodes")).toHaveTextContent('"id":"goal"');
    });
    expect(screen.getByTestId("flow-nodes")).not.toHaveTextContent('"selected"');
  });

  it("selects and clears nodes without a React Flow feedback loop", async () => {
    function SelectionHarness() {
      const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(
        "goal",
      );
      return (
        <>
          <GraphEditor
            snapshot={snapshot}
            selectedNodeId={selectedNodeId}
            onNodeSelect={setSelectedNodeId}
          />
          <output data-testid="external-selected-node">{selectedNodeId ?? ""}</output>
        </>
      );
    }

    render(<SelectionHarness />);
    await waitFor(() => {
      expect(screen.getByTestId("flow-nodes")).toHaveTextContent('"id":"goal"');
    });

    fireEvent.click(screen.getByTestId("flow-node-goal"));
    expect(screen.getByTestId("external-selected-node")).toHaveTextContent("goal");

    fireEvent.click(screen.getByTestId("flow-pane"));

    await waitFor(() => {
      expect(screen.getByTestId("external-selected-node")).toHaveTextContent("");
    });
    expect(flowHarness.selectionEffectCount).toBeLessThan(10);
  });
});
