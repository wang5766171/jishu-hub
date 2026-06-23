import { describe, expect, it } from "vitest";
import {
  detectMissingTaskPhaseSessionPrompt,
  detectTaskPhaseAdvancePrompt,
  resolveTaskPhaseAdvanceProjectRoot,
} from "./task-phase-advance";

describe("detectTaskPhaseAdvancePrompt", () => {
  it("detects requirements to planning after the agent advances state", () => {
    const prompt = detectTaskPhaseAdvancePrompt({
      taskId: "task_1",
      previousStatus: "requirements_discussing",
      activePhase: "requirements",
      instance: {
        status: "planning_discussing",
        current_phase: "planning",
        title: "final requirements",
        requirement_file: "requirements.md",
      },
    });

    expect(prompt).toMatchObject({
      taskId: "task_1",
      fromPhase: "requirements",
      toPhase: "planning",
      title: "final requirements",
    });
  });

  it("recovers a requirements to planning prompt when previous status was not captured", () => {
    const prompt = detectTaskPhaseAdvancePrompt({
      taskId: "task_1",
      previousStatus: null,
      activePhase: "requirements",
      instance: {
        status: "planning_discussing",
        current_phase: "planning",
        title: "final requirements",
        requirement_file: "requirements.md",
      },
    });

    expect(prompt).toMatchObject({
      taskId: "task_1",
      fromPhase: "requirements",
      toPhase: "planning",
      title: "final requirements",
    });
  });

  it("recovers a requirements to planning prompt when status was already synchronized but UI stayed in requirements", () => {
    const prompt = detectTaskPhaseAdvancePrompt({
      taskId: "task_1",
      previousStatus: "planning_discussing",
      activePhase: "requirements",
      instance: {
        status: "planning_discussing",
        current_phase: "planning",
        title: "final requirements",
        requirement_file: "requirements.md",
      },
    });

    expect(prompt).toMatchObject({
      taskId: "task_1",
      fromPhase: "requirements",
      toPhase: "planning",
      title: "final requirements",
    });
  });

  it("does not show the requirements prompt for an already-active planning turn", () => {
    expect(detectTaskPhaseAdvancePrompt({
      taskId: "task_1",
      previousStatus: null,
      activePhase: "planning",
      instance: {
        status: "planning_discussing",
        current_phase: "planning",
        title: "final requirements",
        requirement_file: "requirements.md",
      },
    })).toBeNull();
  });

  it("does not recover a prompt without an active phase", () => {
    expect(detectTaskPhaseAdvancePrompt({
      taskId: "task_1",
      previousStatus: null,
      instance: {
        status: "planning_discussing",
        current_phase: "planning",
        title: "final requirements",
        requirement_file: "requirements.md",
      },
    })).toBeNull();
  });

  it("detects planning to execution after the agent advances state", () => {
    const prompt = detectTaskPhaseAdvancePrompt({
      taskId: "task_2",
      previousStatus: "planning_discussing",
      activePhase: "planning",
      instance: {
        status: "graph_created",
        current_phase: "execution",
        title: "flow plan",
        requirement_file: "requirements.md",
      },
    });

    expect(prompt).toMatchObject({
      taskId: "task_2",
      fromPhase: "planning",
      toPhase: "execution",
      title: "flow plan",
    });
  });

  it("recovers a planning to execution prompt when previous status was not captured", () => {
    const prompt = detectTaskPhaseAdvancePrompt({
      taskId: "task_2",
      previousStatus: null,
      activePhase: "planning",
      instance: {
        status: "graph_created",
        current_phase: "execution",
        title: "flow plan",
        requirement_file: "requirements.md",
      },
    });

    expect(prompt).toMatchObject({
      taskId: "task_2",
      fromPhase: "planning",
      toPhase: "execution",
      title: "flow plan",
    });
  });

  it("recovers a planning to execution prompt when status was already synchronized but UI stayed in planning", () => {
    const prompt = detectTaskPhaseAdvancePrompt({
      taskId: "task_2",
      previousStatus: "graph_created",
      activePhase: "planning",
      instance: {
        status: "graph_created",
        current_phase: "execution",
        title: "flow plan",
        requirement_file: "requirements.md",
      },
    });

    expect(prompt).toMatchObject({
      taskId: "task_2",
      fromPhase: "planning",
      toPhase: "execution",
      title: "flow plan",
    });
  });

  it("ignores unchanged or incomplete state", () => {
    expect(detectTaskPhaseAdvancePrompt({
      taskId: "task_3",
      previousStatus: "planning_discussing",
      activePhase: "planning",
      instance: {
        status: "planning_discussing",
        current_phase: "planning",
        title: "flow plan",
      },
    })).toBeNull();
  });
});

describe("detectMissingTaskPhaseSessionPrompt", () => {
  it("prompts to create the planning session when the task is already in planning without a planning session", () => {
    expect(detectMissingTaskPhaseSessionPrompt({
      taskId: "task_1",
      requestedPhase: "planning",
      instance: {
        status: "planning_discussing",
        current_phase: "planning",
        title: "idea memory app",
        requirement_file: "requirements.md",
        planning_session_id: null,
      },
    })).toMatchObject({
      taskId: "task_1",
      fromPhase: "requirements",
      toPhase: "planning",
      title: "idea memory app",
    });
  });

  it("does not prompt for planning when the planning session already exists", () => {
    expect(detectMissingTaskPhaseSessionPrompt({
      taskId: "task_1",
      requestedPhase: "planning",
      instance: {
        status: "planning_discussing",
        current_phase: "planning",
        title: "idea memory app",
        requirement_file: "requirements.md",
        planning_session_id: "session_1",
      },
    })).toBeNull();
  });

  it("prompts to enter execution when the task is already in execution without a graph", () => {
    expect(detectMissingTaskPhaseSessionPrompt({
      taskId: "task_2",
      requestedPhase: "execution",
      instance: {
        status: "graph_created",
        current_phase: "execution",
        title: "flow plan",
        requirement_file: "requirements.md",
        planning_session_id: "session_2",
        graph_id: null,
      },
    })).toMatchObject({
      taskId: "task_2",
      fromPhase: "planning",
      toPhase: "execution",
      title: "flow plan",
    });
  });
});

describe("resolveTaskPhaseAdvanceProjectRoot", () => {
  it("prefers the live project path from refs used by mount-only listeners", () => {
    expect(resolveTaskPhaseAdvanceProjectRoot({
      liveProjectPath: "E:/current",
      capturedProjectPath: "E:/stale",
    })).toBe("E:/current");
  });
});
