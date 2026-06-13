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
    children,
    onSelectionChange,
    onPaneClick,
  }: {
    nodes: Array<{ id: string; selected?: boolean }>;
    children: React.ReactNode;
    onSelectionChange?: (params: {
      nodes: Array<{ id: string; selected?: boolean }>;
      edges: unknown[];
    }) => void;
    onPaneClick?: () => void;
  }) => {
    React.useEffect(() => {
      if (nodes.length === 0) return;
      flowHarness.selectionEffectCount += 1;
      if (flowHarness.selectionEffectCount > 20) {
        throw new Error("selection feedback loop");
      }
      onSelectionChange?.({
        nodes: nodes.filter((node) => node.selected),
        edges: [],
      });
    }, [nodes, onSelectionChange]);

    return (
      <div>
        <button type="button" data-testid="flow-pane" onClick={onPaneClick}>
          pane
        </button>
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
  Position: { Top: "top", Bottom: "bottom" },
}));

class WorkerStub {
  static postMessageCount = 0;

  onmessage: ((event: MessageEvent) => void) | null = null;

  postMessage(message: { requestId: number }) {
    WorkerStub.postMessageCount += 1;
    this.onmessage?.({
      data: { requestId: message.requestId, positions: {} },
    } as MessageEvent);
  }

  terminate() {}
}

vi.stubGlobal("Worker", WorkerStub);

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

describe("graph editor controlled selection", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(() => {
    flowHarness.selectionEffectCount = 0;
  });

  it("clears React Flow selection when the inspector closes", async () => {
    WorkerStub.postMessageCount = 0;
    const { rerender } = render(
      <GraphEditor
        snapshot={snapshot}
        selectedNodeId="goal"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("flow-nodes")).toHaveTextContent(
        '"selected":true',
      );
    });

    rerender(
      <GraphEditor
        snapshot={snapshot}
        selectedNodeId={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("flow-nodes")).toHaveTextContent(
        '"selected":false',
      );
    });
    expect(WorkerStub.postMessageCount).toBe(1);
  });

  it("clears selection from the pane without a React Flow feedback loop", async () => {
    function SelectionHarness() {
      const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(
        "goal",
      );
      return (
        <GraphEditor
          snapshot={snapshot}
          selectedNodeId={selectedNodeId}
          onNodeSelect={setSelectedNodeId}
        />
      );
    }

    render(<SelectionHarness />);
    await waitFor(() => {
      expect(screen.getByTestId("flow-nodes")).toHaveTextContent(
        '"selected":true',
      );
    });

    fireEvent.click(screen.getByTestId("flow-pane"));

    await waitFor(() => {
      expect(screen.getByTestId("flow-nodes")).toHaveTextContent(
        '"selected":false',
      );
    });
    expect(flowHarness.selectionEffectCount).toBeLessThan(10);
  });
});
