import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskWorkbench } from "./index";

const graphHarness = vi.hoisted(() => ({
  createGraph: vi.fn(),
  generateProposal: vi.fn(),
  clearGraph: vi.fn(),
  loadGraph: vi.fn().mockResolvedValue(undefined),
  pollRunProjection: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    if (command === "task_plan_skill_list") {
      return Promise.resolve([
        {
          id: "jishu-task-planner",
          name: "Jishu Task Planner",
          description: "Task planning skill",
          installed: true,
          installable: true,
          valid: true,
          error: null,
          content_hash: "sha256:planner",
        },
      ]);
    }
    if (command === "orchestrator_list_graphs_for_project") return Promise.resolve([]);
    return Promise.resolve(null);
  }),
}));

vi.mock("./graph-editor", () => ({
  GraphEditor: () => <div data-testid="graph-editor">graph editor</div>,
}));

vi.mock("./task-conversation-panel", () => ({
  TaskConversationPanel: () => (
    <div data-testid="task-conversation-panel">task conversation</div>
  ),
}));

vi.mock("./run-inspector", () => ({
  RunInspector: () => <div data-testid="run-inspector">run inspector</div>,
}));

vi.mock("./use-task-graph", () => ({
  useTaskGraph: () => ({
    graph: null,
    snapshot: null,
    revision: null,
    loading: false,
    error: null,
    createGraph: graphHarness.createGraph,
    applyCommands: vi.fn(),
    activeRunId: null,
    displayedRunId: null,
    runStatus: null,
    nodeRuns: {},
    events: [],
    approvals: [],
    artifacts: [],
    revisions: [],
    proposal: null,
    planning: false,
    planningProgress: null,
    planningText: "",
    startRun: vi.fn(),
    pollRunProjection: graphHarness.pollRunProjection,
    loadGraph: graphHarness.loadGraph,
    loadLatestGraphForProject: vi.fn().mockResolvedValue(false),
    clearGraph: graphHarness.clearGraph,
    pauseRun: vi.fn(),
    resumeRun: vi.fn(),
    cancelRun: vi.fn(),
    resolveApproval: vi.fn(),
    generateProposal: graphHarness.generateProposal,
    acceptProposal: vi.fn(),
    dismissProposal: vi.fn(),
    canUndo: false,
    canRedo: false,
    undo: vi.fn(),
    redo: vi.fn(),
    applyDraftToRun: vi.fn(),
    canApplyDraftToRun: false,
  }),
}));

describe("task workbench phase 4A planning chat", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(() => {
    graphHarness.createGraph.mockReset();
    graphHarness.generateProposal.mockReset();
    graphHarness.clearGraph.mockReset();
  });

  it("replies during requirement discussion and creates after confirmation", async () => {
    graphHarness.createGraph.mockResolvedValue({
      graph_id: "graph_1",
      title: "local inspiration task",
      goal: "goal",
      project_root: "D:\\project",
      owner: "local_user",
      current_draft_revision: "rev_1",
      created_at: 1,
      updated_at: 1,
    });

    render(<TaskWorkbench initialProjectPath={"D:\\project"} />);

    const input = await screen.findByPlaceholderText(
      i18n.t("tasks.workbench.planningChat.placeholder"),
    );
    fireEvent.change(input, {
      target: { value: "Build a local inspiration capture app" },
    });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(screen.getAllByText(/Build a local inspiration capture app/).length).toBeGreaterThan(0);
    });
    await screen.findByText(/生成任务流程图/);
    expect(graphHarness.createGraph).not.toHaveBeenCalled();

    fireEvent.change(input, {
      target: { value: "Add a required human acceptance node" },
    });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(screen.getAllByText(/Add a required human acceptance node/).length).toBeGreaterThan(0);
    });

    fireEvent.change(input, {
      target: { value: "生成任务流程图" },
    });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(graphHarness.createGraph).toHaveBeenCalledWith(
        "Build a local inspiration capture app",
        expect.stringContaining("Add a required human acceptance node"),
        "D:\\project",
        [{ skill_id: "jishu-task-planner", version_or_hash: "sha256:planner", inputs: {} }],
      );
    });
  });

  it("can generate directly from the selected creation mode", async () => {
    graphHarness.createGraph.mockResolvedValue({
      graph_id: "graph_direct",
      title: "one sentence task",
      goal: "goal",
      project_root: "D:\\project",
      owner: "local_user",
      current_draft_revision: "rev_direct",
      created_at: 1,
      updated_at: 1,
    });

    render(<TaskWorkbench initialProjectPath={"D:\\project"} />);

    fireEvent.change(await screen.findByLabelText(i18n.t("tasks.creationMode.label")), {
      target: { value: "direct" },
    });
    const input = screen.getByPlaceholderText(
      i18n.t("tasks.workbench.planningChat.placeholder"),
    );
    fireEvent.change(input, {
      target: { value: "Directly generate a workflow for a local notes app" },
    });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(graphHarness.createGraph).toHaveBeenCalledWith(
        "Directly generate a workflow for a local notes app",
        expect.stringContaining("Directly generate a workflow for a local notes app"),
        "D:\\project",
        [{ skill_id: "jishu-task-planner", version_or_hash: "sha256:planner", inputs: {} }],
      );
    });
  });
});
