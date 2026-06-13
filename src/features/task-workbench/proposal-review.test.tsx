import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProposalReview } from "./proposal-review";
import type { GraphProposal } from "./use-task-graph";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function makeProposal(commandIds: string[]): GraphProposal {
  return {
    proposal_id: "p1",
    graph_id: "g1",
    base_revision_id: "r1",
    commands: commandIds.map((id, i) => ({
      op: "add_node",
      command_id: id,
      node: { node_id: `n${i}`, title: `Node ${i}` },
    })),
    rationale: "r",
    expected_benefits: [],
    risks: [],
    warnings: [],
    diff: {
      from_revision_id: "r1",
      to_revision_id: "r2",
      nodes_added: commandIds,
      nodes_removed: [],
      nodes_updated: [],
      edges_added: [],
      edges_removed: [],
      policy_changes: [],
    },
    planner_assignment: {},
    skill_refs: [],
    template_refs: [],
  } as unknown as GraphProposal;
}

describe("ProposalReview per-command accept", () => {
  it("accepts all commands by default", async () => {
    const onAccept = vi.fn().mockResolvedValue(undefined);
    render(
      <ProposalReview
        proposal={makeProposal(["c1", "c2"])}
        accepting={false}
        onAccept={onAccept}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("tasks.workbench.acceptProposal"));
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith(["c1", "c2"]));
  });

  it("accepts only the still-selected commands after unchecking one", async () => {
    const onAccept = vi.fn().mockResolvedValue(undefined);
    render(
      <ProposalReview
        proposal={makeProposal(["c1", "c2"])}
        accepting={false}
        onAccept={onAccept}
        onDismiss={() => {}}
      />,
    );
    // The first checkbox corresponds to command c1.
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByText("tasks.workbench.acceptProposal"));
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith(["c2"]));
  });
});
