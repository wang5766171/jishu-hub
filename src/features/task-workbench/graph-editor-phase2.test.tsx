import i18n from "@/i18n";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GraphEditor } from "./graph-editor";
import type { GraphSnapshot } from "./use-task-graph";

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({
    nodes,
    children,
    onMoveEnd,
  }: {
    nodes: Array<{ id: string }>;
    children: React.ReactNode;
    onMoveEnd?: (
      event: unknown,
      viewport: { x: number; y: number; zoom: number },
    ) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="zoom-out"
        onClick={() => onMoveEnd?.(null, { x: 0, y: 0, zoom: 0.38 })}
      >
        zoom out
      </button>
      <output data-testid="flow-nodes">{JSON.stringify(nodes)}</output>
      {children}
    </div>
  ),
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
      node_id: "phase_a",
      parent_id: "goal",
      title: "Phase A",
      description: null,
      node_kind: "group",
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
      parent_id: "phase_a",
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
    {
      node_id: "step_b",
      parent_id: "goal",
      title: "Step B",
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

describe("graph editor phase 2 canvas controls", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("shows revision status and semantic zoom state", async () => {
    render(
      <GraphEditor
        snapshot={snapshot}
        currentRevisionId="rev_42"
        canUndo
      />,
    );

    expect(await screen.findByText("rev_42")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("tasks.workbench.revisionStatus.dirty"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("tasks.workbench.semanticZoom.detail"))).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("zoom-out"));
    expect(screen.getByText(i18n.t("tasks.workbench.semanticZoom.map"))).toBeInTheDocument();
  });

  it("filters the canvas by phase without requiring JSON input", async () => {
    render(<GraphEditor snapshot={snapshot} />);

    await waitFor(() => {
      expect(screen.getByTestId("flow-nodes")).toHaveTextContent("step_b");
    });

    fireEvent.click(screen.getByRole("button", { name: "Phase A" }));
    await waitFor(() => {
      const nodeData = screen.getByTestId("flow-nodes").textContent ?? "";
      expect(nodeData).toContain("phase_a");
      expect(nodeData).toContain("step_a");
      expect(nodeData).not.toContain("step_b");
    });
  });
});
