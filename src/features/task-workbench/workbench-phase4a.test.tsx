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

  it("collects multiple user turns before creating the task graph", async () => {
    graphHarness.createGraph.mockResolvedValue({
      graph_id: "graph_1",
      title: "本地录音任务",
      goal: "goal",
      project_root: "D:\\project",
      owner: "local_user",
      current_draft_revision: "rev_1",
      created_at: 1,
      updated_at: 1,
    });

    render(<TaskWorkbench initialProjectPath={"D:\\project"} />);

    const newTaskButtons = await screen.findAllByRole("button", {
      name: i18n.t("tasks.newTask"),
    });
    fireEvent.click(newTaskButtons[0]);

    const createButton = await screen.findByRole("button", {
      name: i18n.t("tasks.createAndPlan"),
    });
    expect(createButton).toBeDisabled();

    const input = screen.getByPlaceholderText(
      i18n.t("tasks.workbench.planningChat.placeholder"),
    );
    fireEvent.change(input, {
      target: { value: "我要做一个本地灵感记录软件" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("tasks.workbench.planningChat.addMessage"),
      }),
    );

    fireEvent.change(input, {
      target: { value: "补充：流程里必须有人为验收节点" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("tasks.workbench.planningChat.addMessage"),
      }),
    );

    fireEvent.change(screen.getByLabelText(i18n.t("tasks.taskTitle")), {
      target: { value: "本地灵感记录任务" },
    });
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(graphHarness.createGraph).toHaveBeenCalledWith(
        "本地灵感记录任务",
        expect.stringContaining("用户: 我要做一个本地灵感记录软件"),
        "D:\\project",
        [{ skill_id: "jishu-task-planner", version_or_hash: "sha256:planner", inputs: {} }],
      );
    });
    expect(graphHarness.createGraph.mock.calls[0][1]).toContain(
      "用户: 补充：流程里必须有人为验收节点",
    );
  });
});
