import { describe, expect, it } from "vitest";
import { deriveTaskLaunchNavItems } from "./task-launch-phase-nav";

describe("deriveTaskLaunchNavItems", () => {
  it("keeps requirements active and locks later phases before any task context exists", () => {
    const items = deriveTaskLaunchNavItems({
      activePhase: "requirements",
      instance: null,
    });

    expect(items).toEqual([
      { phase: "requirements", state: "active", disabled: false },
      { phase: "planning", state: "pending", disabled: true },
      { phase: "execution", state: "pending", disabled: true },
    ]);
  });

  it("allows manual planning when a requirements conversation exists even if the agent did not advance", () => {
    const items = deriveTaskLaunchNavItems({
      activePhase: "requirements",
      instance: {
        status: "requirements_discussing",
        current_phase: "requirements",
        requirement_session_id: "session-1",
      },
      hasRequirementConversation: true,
    });

    expect(items.find((item) => item.phase === "planning")).toEqual({
      phase: "planning",
      state: "ready",
      disabled: false,
    });
  });

  it("allows manual execution creation after planning has a conversation", () => {
    const items = deriveTaskLaunchNavItems({
      activePhase: "planning",
      instance: {
        status: "planning_discussing",
        current_phase: "planning",
        requirement_file: "requirements.md",
        planning_session_id: "session-2",
      },
    });

    expect(items.find((item) => item.phase === "execution")).toEqual({
      phase: "execution",
      state: "ready",
      disabled: false,
    });
  });

  it("marks execution reachable when the graph is already attached", () => {
    const items = deriveTaskLaunchNavItems({
      activePhase: "planning",
      instance: {
        status: "graph_created",
        current_phase: "execution",
        requirement_file: "requirements.md",
        planning_session_id: "session-2",
        graph_id: "graph-1",
      },
    });

    expect(items.find((item) => item.phase === "execution")).toEqual({
      phase: "execution",
      state: "done",
      disabled: false,
    });
  });
});
