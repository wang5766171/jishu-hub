import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TaskWorkbench } from "./index";

const graphHarness = vi.hoisted(() => ({
  createGraph: vi.fn(),
  applyCommands: vi.fn(),
  startRun: vi.fn(),
  pollRunProjection: vi.fn(),
  loadGraph: vi.fn().mockResolvedValue(undefined),
  loadLatestGraphForProject: vi.fn().mockResolvedValue(false),
  clearGraph: vi.fn(),
  pauseRun: vi.fn(),
  resumeRun: vi.fn(),
  cancelRun: vi.fn(),
  resolveApproval: vi.fn(),
  generateProposal: vi.fn(),
  acceptProposal: vi.fn(),
  dismissProposal: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  applyDraftToRun: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    if (command === "task_plan_skill_list") return Promise.resolve([]);
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
    graph: {
      graph_id: "graph_1",
      title: "Build recorder app",
      goal: "Create a local recorder task flow",
      project_root: "D:\\project",
      owner: "user",
      current_draft_revision: "rev_2",
      created_at: 1,
      updated_at: 2,
    },
    snapshot: {
      nodes: [],
      edges: [],
    },
    revision: null,
    loading: false,
    error: null,
    createGraph: graphHarness.createGraph,
    applyCommands: graphHarness.applyCommands,
    activeRunId: "run_1",
    displayedRunId: "run_1",
    runStatus: "running",
    nodeRuns: {
      node_1: { status: "awaiting_approval" },
      node_2: { status: "failed" },
    },
    events: [],
    approvals: [{ approval_id: "approval_1", resolved: false }],
    artifacts: [],
    revisions: [],
    proposal: null,
    planning: false,
    planningProgress: null,
    planningText: "",
    startRun: graphHarness.startRun,
    pollRunProjection: graphHarness.pollRunProjection,
    loadGraph: graphHarness.loadGraph,
    loadLatestGraphForProject: graphHarness.loadLatestGraphForProject,
    clearGraph: graphHarness.clearGraph,
    pauseRun: graphHarness.pauseRun,
    resumeRun: graphHarness.resumeRun,
    cancelRun: graphHarness.cancelRun,
    resolveApproval: graphHarness.resolveApproval,
    generateProposal: graphHarness.generateProposal,
    acceptProposal: graphHarness.acceptProposal,
    dismissProposal: graphHarness.dismissProposal,
    canUndo: false,
    canRedo: false,
    undo: graphHarness.undo,
    redo: graphHarness.redo,
    applyDraftToRun: graphHarness.applyDraftToRun,
    canApplyDraftToRun: false,
  }),
}));

describe("task workbench phase 1 shell", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("shows context bar and switches between chat, canvas, and split modes", async () => {
    render(<TaskWorkbench initialProjectPath="D:\\project" initialGraphId="graph_1" />);

    expect(await screen.findByText("Build recorder app")).toBeInTheDocument();
    expect(screen.getByText("run_1")).toBeInTheDocument();
    expect(screen.getByText("rev_2")).toBeInTheDocument();
    expect(screen.getAllByText("1")).toHaveLength(2);

    expect(screen.getByRole("button", { name: "会话模式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "画布模式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "分屏模式" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "会话模式" }));
    expect(await screen.findByTestId("task-conversation-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("graph-editor")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "画布模式" }));
    expect(await screen.findByTestId("graph-editor")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId("task-conversation-panel")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "分屏模式" }));
    expect(await screen.findByTestId("graph-editor")).toBeInTheDocument();
    expect(await screen.findByTestId("task-conversation-panel")).toBeInTheDocument();
  });
});
