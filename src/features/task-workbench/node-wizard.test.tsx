import i18n from "@/i18n";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GraphEditor } from "./graph-editor";
import type { GraphSnapshot } from "./use-task-graph";

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
  ],
  edges: [],
};

describe("node wizard", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("creates an executable node from intent, prompt, and acceptance fields", async () => {
    const applyCommands = vi.fn().mockResolvedValue(undefined);
    render(<GraphEditor snapshot={snapshot} applyCommands={applyCommands} />);

    fireEvent.click(screen.getByRole("button", { name: i18n.t("tasks.workbench.addAgentStep") }));
    expect(await screen.findByText(i18n.t("tasks.workbench.nodeWizard.title"))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("tasks.workbench.nodeWizard.intents.verify") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("tasks.workbench.nodeWizard.next") }));

    fireEvent.change(screen.getByLabelText(i18n.t("tasks.workbench.stepTitle")), {
      target: { value: "验证 MVP" },
    });
    fireEvent.change(screen.getByLabelText(i18n.t("tasks.workbench.stepPrompt")), {
      target: { value: "运行核心验收并整理问题" },
    });
    fireEvent.change(screen.getByLabelText(i18n.t("tasks.workbench.nodeWizard.acceptance")), {
      target: { value: "输出可复测的验收报告" },
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("tasks.workbench.nodeWizard.next") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("tasks.workbench.createStep") }));

    await waitFor(() => {
      expect(applyCommands).toHaveBeenCalledWith([
        expect.objectContaining({
          op: "add_node",
          node: expect.objectContaining({
            title: "验证 MVP",
            metadata: expect.objectContaining({ intent: "verify" }),
            output_contract: expect.objectContaining({
              description: "输出可复测的验收报告",
            }),
            executable_payload: expect.objectContaining({
              prompt: expect.stringContaining("运行核心验收并整理问题"),
            }),
          }),
        }),
      ]);
    });
  });
});
