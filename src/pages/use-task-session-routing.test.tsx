/**
 * 任务会话导流钩子单测——v0.9.8 需求24 续，对应 tests/06-测试清单：
 * S24-U7 打开任务主会话走普通会话那个打开函数；
 * S24-U9 节点会话也走同一个打开函数；
 * S24-U10 选中节点前先记离开位置，取消选中回到主会话也走打开函数。
 *
 * 打开函数在这里是替身：只看「谁被打开、带了什么标记」，读消息 / 定位本身由
 * use-session-selection 的测试覆盖。
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TaskLaunchInstanceSummary } from "@/features/task-instance/types";
import { useTaskSessionRouting } from "./use-task-session-routing";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/features/task-instance/task-phase-debug", () => ({ logTaskPhaseDebug: () => {} }));

const task = {
  task_id: "task-1",
  title: "整理文档",
  skill_id: "jishu-task-runner",
  status: "running",
  task_session_id: "sess-main",
  graph_id: "graph-1",
} as TaskLaunchInstanceSummary;

function setup({ activeTask = task }: { activeTask?: TaskLaunchInstanceSummary } = {}) {
  const handleSelectSession = vi.fn();
  const noteLeavingSession = vi.fn();
  const setSelectedSession = vi.fn();
  const setSessionMessages = vi.fn();
  const setTaskSelectedNodeId = vi.fn();
  const setTaskNodeSessionAgentId = vi.fn();
  const setTaskModeActive = vi.fn();
  const setActiveTaskInstanceId = vi.fn();
  const selectedSessionRef = { current: null as string | null };
  const hook = renderHook(() =>
    useTaskSessionRouting({
      setTaskModeActive,
      setTaskLaunchOpen: vi.fn(),
      setTaskLaunchReadOnly: vi.fn(),
      setTaskLaunchPhase: vi.fn(),
      setActiveTaskInstanceId,
      setActiveTaskRequirementFile: vi.fn(),
      setSelectedTaskSkillId: vi.fn(),
      setTaskSelectedNodeId,
      setTaskNodeSessionAgentId,
      taskLaunchOpenRef: { current: false },
      taskLaunchPhaseRef: { current: "requirements" },
      activeTaskInstanceIdRef: { current: null },
      activeTaskRequirementFileRef: { current: null },
      lastKnownStatusRef: { current: null },
      taskSelectedNodeIdRef: { current: null },
      enteringTaskModeRef: { current: false },
      activeId: "a",
      taskModeActive: false,
      activeTaskLaunchInstance: activeTask,
      taskSelectedNodeId: null,
      taskGraph: { snapshot: null, nodeRuns: {}, runStatus: null },
      nodeSessionMap: {},
      closeSessionSidebar: vi.fn(),
      closeViewer: vi.fn(),
      setSelectedSession,
      selectedSessionRef,
      setSessionMessages,
      chatInputRef: { current: null },
      handleTaskCancelRun: vi.fn(),
      setTaskBoardSignal: vi.fn(),
      taskEngineAgent: null,
      taskModeAgentReady: false,
      setChatAgent: vi.fn(),
      confirmDialog: vi.fn(async () => true),
      alertDialog: vi.fn(async () => undefined),
      handleSelectSessionRef: { current: handleSelectSession },
      noteLeavingSession,
    }),
  );
  return {
    ...hook,
    handleSelectSession,
    noteLeavingSession,
    setSelectedSession,
    setSessionMessages,
    setTaskSelectedNodeId,
    setTaskNodeSessionAgentId,
    setTaskModeActive,
    setActiveTaskInstanceId,
    selectedSessionRef,
  };
}

describe("useTaskSessionRouting · 任务会话与普通会话走同一个打开函数", () => {
  it("进入任务工作台：任务态照常设置，会话交给普通会话那个打开函数（带「保留任务上下文」）——S24-U7", () => {
    const h = setup();
    act(() => {
      h.result.current.openTaskSession(task);
    });
    expect(h.setTaskModeActive).toHaveBeenCalledWith(true);
    expect(h.setActiveTaskInstanceId).toHaveBeenCalledWith("task-1");
    expect(h.setTaskSelectedNodeId).toHaveBeenCalledWith(null);
    expect(h.handleSelectSession).toHaveBeenCalledTimes(1);
    expect(h.handleSelectSession).toHaveBeenCalledWith("sess-main", { keepTaskContext: true });
    // 不再自己直接改选中态
    expect(h.setSelectedSession).not.toHaveBeenCalled();
  });

  it("任务没有关联会话：选中态置空，不调用打开函数", () => {
    const h = setup({ activeTask: { ...task, task_session_id: null } });
    act(() => {
      h.result.current.openTaskSession({ ...task, task_session_id: null });
    });
    expect(h.handleSelectSession).not.toHaveBeenCalled();
    expect(h.setSelectedSession).toHaveBeenCalledWith(null);
  });

  it("节点会话回填：也交给打开函数（带「保留任务上下文 + 节点会话」），记下绑定的智能体——S24-U9", () => {
    const h = setup();
    act(() => {
      h.result.current.handleTaskNodeSessionChange({ session_id: "node-sess", agent_id: "codex" });
    });
    expect(h.handleSelectSession).toHaveBeenCalledWith("node-sess", { keepTaskContext: true, node: true });
    expect(h.setTaskNodeSessionAgentId).toHaveBeenCalledWith("codex");
    expect(h.setSelectedSession).not.toHaveBeenCalled();
  });

  it("节点会话还没回填：主区先换成占位；没有任何节点信息时什么都不动", () => {
    const h = setup();
    act(() => {
      h.result.current.handleTaskNodeSessionChange({ session_id: null, agent_id: null });
    });
    expect(h.setSelectedSession).toHaveBeenCalledWith("pending-node");
    expect(h.selectedSessionRef.current).toBe("pending-node");
    expect(h.handleSelectSession).not.toHaveBeenCalled();

    vi.clearAllMocks();
    act(() => {
      h.result.current.handleTaskNodeSessionChange(null);
    });
    expect(h.setSelectedSession).not.toHaveBeenCalled();
    expect(h.handleSelectSession).not.toHaveBeenCalled();
  });

  it("选中节点：先记下正在离开的会话的滚动位置，主区换成占位；取消选中：回到任务主会话也走打开函数——S24-U10", () => {
    const h = setup();
    act(() => {
      h.result.current.handleTaskSelectNode("node-1");
    });
    expect(h.noteLeavingSession).toHaveBeenCalledTimes(1);
    expect(h.setTaskSelectedNodeId).toHaveBeenCalledWith("node-1");
    expect(h.setSelectedSession).toHaveBeenCalledWith("pending-node");
    expect(h.setSessionMessages).toHaveBeenCalledWith([]);
    expect(h.handleSelectSession).not.toHaveBeenCalled();

    vi.clearAllMocks();
    act(() => {
      h.result.current.handleTaskSelectNode(null);
    });
    expect(h.handleSelectSession).toHaveBeenCalledWith("sess-main", { keepTaskContext: true });
    expect(h.setTaskNodeSessionAgentId).toHaveBeenCalledWith(null);
    // 离开位置由打开函数记（它知道正要离开的是哪个会话）
    expect(h.noteLeavingSession).not.toHaveBeenCalled();
  });
});
