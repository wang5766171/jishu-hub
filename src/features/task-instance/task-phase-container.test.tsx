import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import TaskPhaseContainer from "./task-phase-container";

const taskMock = vi.hoisted(() => ({
  activeInstance: null,
  activeInstanceId: null,
  activePhase: "requirements" as const,
  phaseStates: {
    requirements: "done",
    planning: "active",
    execution: "pending",
  },
  readOnly: false,
  executionView: "split" as const,
  chatScope: { kind: "run" as const },
  selectedNodeId: null,
  nodeSessionMap: {},
  openTask: vi.fn(),
  openPhase: vi.fn(),
  markSession: vi.fn(),
  finalizeRequirements: vi.fn(),
  attachGraph: vi.fn(),
  syncRunStatus: vi.fn(),
  setExecutionView: vi.fn(),
  setChatScope: vi.fn(),
  selectNode: vi.fn(),
  updateNodeSession: vi.fn(),
}));

vi.mock("./use-task-instance", () => ({
  useTaskInstance: () => taskMock,
}));

vi.mock("@/features/task-instance/graph/use-task-graph", () => ({
  useTaskGraph: () => ({
    graph: null,
    loadGraph: vi.fn(),
  }),
}));

vi.mock("./task-phase-nav-bar", () => ({
  TaskPhaseNavBar: () => <div data-testid="phase-nav" />,
}));

vi.mock("./phase-requirements-view", () => ({
  PhaseRequirementsView: () => <div data-testid="requirements-view" />,
}));

vi.mock("./phase-planning-view", () => ({
  PhasePlanningView: () => <div data-testid="planning-view" />,
}));

vi.mock("./phase-execution-view", () => ({
  PhaseExecutionView: () => <div data-testid="execution-view" />,
}));

describe("TaskPhaseContainer", () => {
  beforeEach(() => {
    taskMock.openTask.mockReset();
    taskMock.openPhase.mockReset();
  });

  it("opens the initial phase as read-only when requested", () => {
    render(
      <TaskPhaseContainer
        projectPath="D:/workspace/demo"
        initialTaskId="task_1"
        initialPhase="requirements"
        initialReadOnly
      />,
    );

    expect(taskMock.openTask).toHaveBeenCalledWith("task_1");
    expect(taskMock.openPhase).toHaveBeenCalledWith("requirements", true);
  });
});
