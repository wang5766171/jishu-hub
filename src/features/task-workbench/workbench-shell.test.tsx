import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskWorkbench } from "./index";
import { RunInspector } from "./run-inspector";

const invokeMock = vi.fn();
const taskGraphHarness = vi.hoisted(() => ({
  clearGraph: vi.fn(),
  loadGraph: vi.fn().mockResolvedValue(undefined),
  pollRunProjection: vi.fn(),
  generateProposal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("./use-task-graph", () => ({
  useTaskGraph: () => ({
    graph: null,
    snapshot: null,
    revision: null,
    loading: false,
    error: null,
    createGraph: vi.fn(),
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
    startRun: vi.fn(),
    pollRunProjection: taskGraphHarness.pollRunProjection,
    loadGraph: taskGraphHarness.loadGraph,
    loadLatestGraphForProject: vi.fn().mockResolvedValue(false),
    clearGraph: taskGraphHarness.clearGraph,
    pauseRun: vi.fn(),
    resumeRun: vi.fn(),
    cancelRun: vi.fn(),
    resolveApproval: vi.fn(),
    generateProposal: taskGraphHarness.generateProposal,
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

describe("task workbench shell", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "task_plan_skill_list") return Promise.resolve([]);
      if (command === "orchestrator_list_graphs_for_project") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
  });

  it("opens on a task list with new-task and close actions", async () => {
    const onClose = vi.fn();
    render(
      <TaskWorkbench
        initialProjectPath="D:\\project"
        onClose={onClose}
      />,
    );

    expect(await screen.findByRole("heading", { name: "任务" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "新建任务" })).not.toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "关闭任务页面" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("run details has an explicit close action", async () => {
    const onClose = vi.fn();
    render(
      <RunInspector
        runId="run_1"
        events={[]}
        approvals={[]}
        artifacts={[]}
        revisions={[]}
        currentRevisionId={null}
        onResolveApproval={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "关闭运行详情" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("installs a missing planning skill from the task creation page", async () => {
    const missingSkill = {
      id: "jishu-task-planner",
      name: "Jishu Task Planner",
      description: "Task planning skill",
      installed: false,
      installable: true,
      valid: false,
      error: null,
      content_hash: "",
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "task_plan_skill_list") {
        return Promise.resolve([missingSkill]);
      }
      if (command === "task_plan_skill_install") {
        return Promise.resolve({
          ...missingSkill,
          installed: true,
          valid: true,
          content_hash: "sha256:installed",
        });
      }
      if (command === "orchestrator_list_graphs_for_project") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(<TaskWorkbench initialProjectPath="D:\\project" />);

    const newTaskButtons = await screen.findAllByRole("button", {
      name: i18n.t("tasks.newTask"),
    });
    fireEvent.click(newTaskButtons[0]);

    expect(await screen.findByText(i18n.t("tasks.notInstalled"))).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("tasks.installSkill") }),
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("task_plan_skill_install", {
        skillId: "jishu-task-planner",
      });
      expect(screen.getByText(i18n.t("tasks.installed"))).toBeInTheDocument();
    });
  });
});
