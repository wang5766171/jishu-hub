import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskInstanceRaw } from "./types";
import { useTaskInstance } from "./use-task-instance";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));

// 可变：控制 task_launch_list_sessions 返回的 current_phase，模拟 conductor 推进后
// 容器经 onTurnComplete → loadInstances 刷新到的最新实例。
let currentPhase = "requirements";

function rawTask(): TaskInstanceRaw {
  return {
    task_id: "task_1",
    project_root: "D:/workspace/demo",
    title: "演示任务",
    skill_id: "jishu-conductor-default",
    planner_agent_id: "jishu-self",
    status: "requirements_discussing",
    current_phase: currentPhase,
    requirement_session_id: "sess-req",
    planning_session_id: null,
    graph_id: null,
    active_run_id: null,
    last_run_id: null,
    run_status: null,
    created_at: 0,
    updated_at: 0,
  };
}

function Harness() {
  const task = useTaskInstance({ projectRoot: "D:/workspace/demo" });
  return (
    <div>
      <div data-testid="active-phase">{task.activePhase}</div>
      <button data-testid="open" onClick={() => task.openTask("task_1")}>
        open
      </button>
      <button data-testid="to-requirements" onClick={() => task.openPhase("requirements")}>
        req
      </button>
      <button data-testid="reload" onClick={() => task.loadInstances()}>
        reload
      </button>
    </div>
  );
}

describe("useTaskInstance 阶段标签自动跟随", () => {
  beforeEach(() => {
    currentPhase = "requirements";
    invokeCommand.mockReset();
    invokeCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "task_launch_list_sessions") return [rawTask()];
      return null;
    });
  });

  it("current_phase 前进时自动跟随（requirements → planning）", async () => {
    render(<Harness />);

    // 打开任务（current_phase=requirements）。
    await act(async () => {
      screen.getByTestId("open").click();
    });
    await waitFor(() => expect(screen.getByTestId("active-phase")).toHaveTextContent("requirements"));

    // conductor 推进到 planning，turn 结束后容器刷新实例。
    currentPhase = "planning";
    await act(async () => {
      screen.getByTestId("reload").click();
    });

    // activePhase 应自动跟随到 planning。
    await waitFor(() => expect(screen.getByTestId("active-phase")).toHaveTextContent("planning"));
  });

  it("用户手动回看后，current_phase 前进不覆盖手动导航", async () => {
    render(<Harness />);

    await act(async () => {
      screen.getByTestId("open").click();
    });
    // 推进到 planning → 自动跟随。
    currentPhase = "planning";
    await act(async () => {
      screen.getByTestId("reload").click();
    });
    await waitFor(() => expect(screen.getByTestId("active-phase")).toHaveTextContent("planning"));

    // 用户手动回看到 requirements（只读回看）。
    await act(async () => {
      screen.getByTestId("to-requirements").click();
    });
    await waitFor(() => expect(screen.getByTestId("active-phase")).toHaveTextContent("requirements"));

    // conductor 继续推进到 execution：用户已手动挪到 requirements，不应被拽走。
    currentPhase = "execution";
    await act(async () => {
      screen.getByTestId("reload").click();
    });
    await waitFor(() => expect(screen.getByTestId("active-phase")).toHaveTextContent("requirements"));
  });
});
