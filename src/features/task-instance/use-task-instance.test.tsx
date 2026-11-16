import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskInstanceRaw } from "./types";
import { useTaskInstance } from "./use-task-instance";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));

// 可变：控制 task_launch_list_sessions 返回的 runner 步骤清单。
let stagesJson: string | null = null;

function rawTask(): TaskInstanceRaw {
  return {
    task_id: "task_1",
    project_root: "D:/workspace/demo",
    title: "演示任务",
    skill_id: "jishu-task-runner",
    planner_agent_id: "jishu-self",
    status: "active",
    task_session_id: "sess-main",
    graph_id: null,
    active_run_id: null,
    last_run_id: null,
    run_status: null,
    stages_json: stagesJson,
    created_at: 0,
    updated_at: 0,
  };
}

function Harness() {
  const task = useTaskInstance({ projectRoot: "D:/workspace/demo" });
  return (
    <div>
      <div data-testid="session">{task.activeSessionId ?? "-"}</div>
      <div data-testid="steps">{task.runnerCard.steps.map((s) => `${s.title}:${s.status}`).join(",")}</div>
      <button data-testid="open" onClick={() => task.openTask("task_1")}>
        open
      </button>
      <button data-testid="reload" onClick={() => task.loadInstances()}>
        reload
      </button>
    </div>
  );
}

describe("useTaskInstance（v0.9.7 去阶段化）", () => {
  beforeEach(() => {
    stagesJson = null;
    invokeCommand.mockReset();
    invokeCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "task_launch_list_sessions") return [rawTask()];
      return null;
    });
  });

  it("打开任务后 activeSessionId 指向 task_session_id（单对话流）", async () => {
    render(<Harness />);
    await act(async () => {
      screen.getByTestId("open").click();
    });
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent("sess-main"));
  });

  it("runnerCard 随 stages_json 刷新（任务卡步骤灯数据源）", async () => {
    stagesJson = null;
    render(<Harness />);
    await act(async () => {
      screen.getByTestId("open").click();
    });
    await waitFor(() => expect(screen.getByTestId("steps")).toHaveTextContent(""));

    stagesJson = JSON.stringify({
      steps: [
        { id: "a", title: "第一步", status: "done" },
        { id: "b", title: "第二步", status: "running" },
      ],
    });
    await act(async () => {
      screen.getByTestId("reload").click();
    });
    await waitFor(() =>
      expect(screen.getByTestId("steps")).toHaveTextContent("第一步:done,第二步:running"),
    );
  });

  it("损坏 stages_json 回落空清单（不抛错）", async () => {
    stagesJson = "not-json";
    render(<Harness />);
    await act(async () => {
      screen.getByTestId("open").click();
    });
    await waitFor(() => expect(screen.getByTestId("steps")).toHaveTextContent(""));
  });
});
