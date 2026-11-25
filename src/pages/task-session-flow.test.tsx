/**
 * 任务工作台的会话流程集成测试——v0.9.8 需求24 续，对应 tests/06-测试清单 S24-U14。
 *
 * 把页面上接在一起的三个钩子原样接起来测：打开函数（useSessionSelection）、滚动系统
 * （useChatScroll）、节点会话补读（useNodeSessionReload）。
 * - U14a：有缓存时打开，定位指令必须在消息上屏的同一轮提交里被消费。分开测各钩子时
 *   看不出来——打开函数多等了一拍（哪怕缓存里已经有消息），指令就落空：界面上表现为
 *   「往上翻后切走再回来，停不到原处」（真实界面验证时抓到过）。
 * - U14b：节点会话的完整流程——进入任务主会话 → 选中节点（占位）→ 节点会话回填 →
 *   消息由补读从磁盘读出来并定位 → 取消选中回到主会话。
 *
 * 打开动作从**真实的点击事件**里触发，并且不放进测试框架的 act 包裹：真实应用里点击
 * 事件一结束 React 就把这一轮更新提交掉，随后才轮到打开函数里「等一拍」之后的代码；
 * 放进 act 里这个先后顺序会反过来，时序问题就测不出来。
 */
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMemo, useRef, useState } from "react";

import type { Message } from "@/types";
import { deleteCachedSessionMessages, setCachedSessionMessages } from "@/features/session-kernel/kernel/session-cache";
import { useChatScroll } from "./use-chat-scroll";
import { useNodeSessionReload } from "./use-node-session-reload";
import type { SearchLensInput } from "./use-search-lens";
import { useSessionSelection, type ReloadSessionMessages, type SelectSessionOptions } from "./use-session-selection";
import { useTaskExecutionStage } from "./use-task-execution-stage";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));
vi.mock("@/lib/dev-log", () => ({ devLog: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const msg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const noop = () => {};

const frames: FrameRequestCallback[] = [];
/** 执行当前排队的帧（每个只跑一次；跑的过程中新排的帧留到下一轮）。 */
function runFrames() {
  const queued = frames.splice(0, frames.length);
  for (const frame of queued) frame(0);
}

type Mode = {
  taskModeActive: boolean;
  taskSelectedNodeId: string | null;
  taskNodeSessionAgentId: string | null;
  /** 任务执行段（S24-U20 用）：是否处于执行段视图、执行流里有几条内容。 */
  execMode?: boolean;
  projected?: unknown[];
};

function useFlow(m: Mode) {
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<Message[]>([]);
  const selectedSessionRef = useRef<string | null>(null);
  const messageAreaRef = useRef<HTMLDivElement | null>(null);
  const scrollMemory = useRef(new Map<string, number | "bottom">());
  const visitedSessions = useRef(new Set<string>());
  const searchLensInputRef = useRef<SearchLensInput>({ query: "", selectedSession: null, hitSessionIds: new Set() });
  const scroll = useChatScroll({ messageAreaRef, sessionMessages, selectedSession, searchLensInputRef });
  const reloadSessionMessagesRef = useRef<ReloadSessionMessages>(() => []);
  const closeViewer = vi.fn();
  const selection = useSessionSelection({
    projectId: "p",
    activeId: "a",
    currentProject: null,
    sessions: [],
    setSessionMessages,
    sessionMessagesRef: { current: sessionMessages },
    setSelectedSession,
    selectedSessionRef,
    messageAreaRef,
    scrollMemory,
    visitedSessions,
    scrollAction: scroll.scrollAction,
    armScroll: scroll.armScroll,
    newSessionStreamIdsRef: { current: new Set<string>() },
    setTaskModeActive: noop,
    setTaskLaunchOpen: noop,
    setTaskLaunchReadOnly: noop,
    taskLaunchOpenRef: { current: false },
    taskLaunchPhaseRef: { current: "requirements" },
    taskLaunchGoalRef: { current: null },
    activeTaskInstanceIdRef: { current: null },
    activeTaskRequirementFileRef: { current: null },
    lastKnownStatusRef: { current: null },
    setActiveTaskInstanceId: noop,
    setActiveTaskRequirementFile: noop,
    setTaskSelectedNodeId: noop,
    setTaskNodeSessionAgentId: noop,
    reloadSessionMessagesRef,
    closeViewer,
    refreshSessionUsageRef: { current: noop },
    isInSearchLens: () => false,
    landsOnSearchHit: () => false,
    jumpToSearchHit: noop,
  });
  useNodeSessionReload({
    taskModeActive: m.taskModeActive,
    selectedSession,
    projectId: "p",
    taskSelectedNodeId: m.taskSelectedNodeId,
    taskNodeSessionAgentId: m.taskNodeSessionAgentId,
    activeId: "a",
    streamTextStarted: false,
    reloadSessionMessagesRef,
  });
  // 任务执行段（S24-U20）：任务图与执行流用最小的假数据；这里只关心它的两处「滚到底」
  const execMode = m.execMode === true;
  const taskGraph = useMemo(
    () => ({ snapshot: null, projectedMessages: m.projected ?? [], nodeRuns: {}, activeRunId: null, runStatus: null }) as never,
    [m.projected],
  );
  useTaskExecutionStage({
    taskExecutionMode: execMode,
    taskRunStarted: true,
    activeTaskLaunchInstance: execMode ? ({ task_id: "task-1", title: "验证", skill_id: "jishu-task-runner", status: "active" } as never) : null,
    taskGraph,
    taskGraphRef: { current: taskGraph },
    boardRunId: null,
    projectPath: "E:/p",
    agents: [],
    confirmDialog: vi.fn(async () => true),
    isAwayFromBottomRef: scroll.isAwayFromBottomRef,
    messageAreaRef,
    sessionMessagesLength: sessionMessages.length,
  });
  return {
    ...selection,
    setSelectedSession,
    selectedSessionRef,
    sessionMessages,
    scrollAction: scroll.scrollAction,
    isAwayFromBottomRef: scroll.isAwayFromBottomRef,
    closeViewer,
    messageAreaRef,
  };
}

function mount(mode: Mode = { taskModeActive: false, taskSelectedNodeId: null, taskNodeSessionAgentId: null }) {
  const el = document.createElement("div");
  const size = { scrollHeight: 1000, clientHeight: 500 };
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => size.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => size.clientHeight });
  // jsdom 给 scrollTop 赋值不会压到可滚动范围内；浏览器会——按浏览器的规矩来
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, size.scrollHeight - size.clientHeight));
    },
  });
  let api: ReturnType<typeof useFlow> | null = null;
  const next = { sessionId: "", options: undefined as SelectSessionOptions | undefined };
  function Harness(props: Mode) {
    api = useFlow(props);
    // 滚动容器由页面挂进文档；这里直接挂上（钩子读的是 ref）
    if (api.messageAreaRef.current !== el) api.messageAreaRef.current = el;
    return <button onClick={() => void api!.handleSelectSession(next.sessionId, next.options)}>打开</button>;
  }
  const view = render(<Harness {...mode} />);
  /** 真实点击打开一个会话；随后等提交与「等一拍」之后的后续都跑完。 */
  const clickOpen = async (sessionId: string, options?: SelectSessionOptions) => {
    next.sessionId = sessionId;
    next.options = options;
    fireEvent.click(view.getByRole("button"));
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    get api() {
      return api!;
    },
    el,
    size,
    clickOpen,
    rerender: (m: Mode) => view.rerender(<Harness {...m} />),
  };
}

const actEnvironmentBefore = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

beforeEach(() => {
  // 不放进 act：让 React 按真实应用的时机提交（点击事件一结束就提交）
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  invokeCommand.mockReset();
  for (const id of ["s1", "s2", "sess-main", "node-sess"]) deleteCachedSessionMessages(id);
  frames.length = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = actEnvironmentBefore;
  vi.unstubAllGlobals();
});

describe("任务工作台的会话流程 · 三个钩子接在一起（从真实点击事件触发）", () => {
  it("有缓存时打开：定位指令在消息上屏的同一轮提交里就被消费——S24-U14a", async () => {
    invokeCommand.mockResolvedValue([msg("s1 的消息")]);
    const h = mount();
    await h.clickOpen("s1");
    expect(h.el.scrollTop).toBe(500); // 首次打开：到底
    // 往上翻一段再切走：记下这个位置
    h.el.scrollTop = 200;
    invokeCommand.mockResolvedValue([msg("s2 的消息")]);
    await h.clickOpen("s2");

    // 再打开 s1：消息在缓存里，不用等磁盘——定位指令必须当场生效
    await h.clickOpen("s1");
    expect(h.api.sessionMessages).toEqual([msg("s1 的消息")]);
    expect(h.api.scrollAction.current).toBeNull();
    expect(h.el.scrollTop).toBe(200);
  });

  it("节点会话的完整流程：进入任务主会话 → 选中节点（占位）→ 节点会话回填 → 消息读出来并定位 → 回到主会话——S24-U14b", async () => {
    setCachedSessionMessages("sess-main", [msg("任务主会话的消息")]);
    invokeCommand.mockResolvedValue([msg("节点会话的消息")]);
    const h = mount();
    await h.clickOpen("sess-main", { keepTaskContext: true });
    expect(h.api.sessionMessages).toEqual([msg("任务主会话的消息")]);
    expect(h.el.scrollTop).toBe(500);

    // 选中节点：导流钩子在同一次更新里落下节点选中态与占位（中间不会出现「节点已选中、
    // 主区还是主会话」的状态，否则补读会把主会话当成节点会话重读）
    const current = h.api;
    current.noteLeavingSession();
    current.setSelectedSession("pending-node");
    h.rerender({ taskModeActive: true, taskSelectedNodeId: "node-1", taskNodeSessionAgentId: null });
    await new Promise((r) => setTimeout(r, 0));

    // 节点会话回填：导流钩子调用打开函数（带「保留任务上下文 + 节点会话」）
    await h.clickOpen("node-sess", { keepTaskContext: true, node: true });
    // 打开函数自己不读磁盘；消息由补读读出来，并按绑定的智能体读
    expect(invokeCommand).toHaveBeenCalledWith("get_session_messages", expect.objectContaining({ sessionId: "node-sess", agentId: "a" }));
    expect(h.api.sessionMessages).toEqual([msg("节点会话的消息")]);
    // 消息到了，定位指令随即被消费（首次打开：到底）
    expect(h.api.scrollAction.current).toBeNull();
    expect(h.el.scrollTop).toBe(500);

    // 取消选中：导流钩子先清掉节点选中态，再调用打开函数回到任务主会话
    //（缓存里有，不用再读磁盘；节点选中态清掉后补读也不再管这个会话）
    const calls = invokeCommand.mock.calls.length;
    h.rerender({ taskModeActive: true, taskSelectedNodeId: null, taskNodeSessionAgentId: null });
    await new Promise((r) => setTimeout(r, 0));
    await h.clickOpen("sess-main", { keepTaskContext: true });
    expect(h.api.sessionMessages).toEqual([msg("任务主会话的消息")]);
    expect(invokeCommand.mock.calls.length).toBe(calls);
  });

  it("打开带任务图的任务：按滚动记忆恢复位置之后任务图才加载完，视图不被拽到底——S24-U20", async () => {
    setCachedSessionMessages("sess-main", [msg("任务主会话的消息")]);
    setCachedSessionMessages("s1", [msg("普通会话的消息")]);
    const mode = { taskModeActive: true, taskSelectedNodeId: null, taskNodeSessionAgentId: null };
    const h = mount(mode);
    await h.clickOpen("sess-main", { keepTaskContext: true });
    expect(h.el.scrollTop).toBe(500); // 首次打开：到底
    // 往上翻一段（真实环境里滚轮会解除贴底跟随、滚动事件会把「离开底部」标记置真）
    h.el.scrollTop = 200;
    h.el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400 }));
    h.el.dispatchEvent(new Event("scroll"));
    await h.clickOpen("s1"); // 切走：记下 200

    // 回来：这一帧内容还不够高（执行卡要等任务图加载完才出现），恢复的位置先被压低
    h.size.scrollHeight = 600;
    await h.clickOpen("sess-main", { keepTaskContext: true });
    expect(h.el.scrollTop).toBe(100);

    // 任务图加载完：内容长出来；执行段同时出现（进入执行段 + 执行流有了内容）
    h.size.scrollHeight = 1200;
    h.rerender({ ...mode, execMode: true, projected: [{ kind: "event" }] });
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 6; i++) runFrames();

    expect(h.el.scrollTop).toBe(200);
  });
});
