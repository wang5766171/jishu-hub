import { describe, expect, it } from "vitest";
import { detectTaskPhaseAdvancePrompt } from "./task-phase-advance";

describe("detectTaskPhaseAdvancePrompt", () => {
  it("detects requirements to planning after the agent advances state", () => {
    const prompt = detectTaskPhaseAdvancePrompt({
      taskId: "task_1",
      previousStatus: "requirements_discussing",
      instance: {
        status: "planning_discussing",
        current_phase: "planning",
        title: "需求终稿",
        requirement_file: "requirements.md",
      },
    });

    expect(prompt).toMatchObject({
      taskId: "task_1",
      fromPhase: "requirements",
      toPhase: "planning",
      title: "需求终稿",
    });
  });

  it("detects planning to execution after the agent advances state", () => {
    const prompt = detectTaskPhaseAdvancePrompt({
      taskId: "task_2",
      previousStatus: "planning_discussing",
      instance: {
        status: "graph_created",
        current_phase: "execution",
        title: "流程图",
        requirement_file: "requirements.md",
      },
    });

    expect(prompt).toMatchObject({
      taskId: "task_2",
      fromPhase: "planning",
      toPhase: "execution",
      title: "流程图",
    });
  });

  it("ignores unchanged or incomplete state", () => {
    expect(detectTaskPhaseAdvancePrompt({
      taskId: "task_3",
      previousStatus: "planning_discussing",
      instance: {
        status: "planning_discussing",
        current_phase: "planning",
        title: "流程图",
      },
    })).toBeNull();
  });
});
