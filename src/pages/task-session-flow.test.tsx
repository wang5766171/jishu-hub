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
 * - U20：打开带任务图的任务，恢复位置之后任务图才加载完，视图不被拽到底。
 *
 * v0.9.8 评审修复轮 R2，对应 docs/v0.9.8/评审修复轮-R2/tests/O-用例清单.md：
 * O1-U1/U4/U7/U8、O3-U2/U3——应用启动后每个会话的第一次打开（消息要从磁盘读）直接落在
 * 最底部；从往上翻着的会话切过去同样；读到空、装载失败时遮蔽当场解除。
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

/** 页面持有、跟软件同寿的两份状态：卸载重挂（切到管理页再回来）也还在，所以可以从外面传进来。 */
interface Shared {
  scrollMemory: Map<string, number | "bottom">;
  visitedSessions: Set<string>;
}

function useFlow(m: Mode, shared?: Shared) {
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<Message[]>([]);
  const selectedSessionRef = useRef<string | null>(null);
  const messageAreaRef = useRef<HTMLDivElement | null>(null);
  const ownMemory = useRef(new Map<string, number | "bottom">());
  const ownVisited = useRef(new Set<string>());
  const scrollMemory = { current: shared?.scrollMemory ?? ownMemory.current };
  const visitedSessions = { current: shared?.visitedSessions ?? ownVisited.current };
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
    selectedSession,
    lastScrollPositionOf: scroll.lastScrollPositionOf,
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
    /** 滚动系统里这个会话最近一次量到的位置（用例核对离开记录的样本）。 */
    lastScrollPositionOf: scroll.lastScrollPositionOf,
    closeViewer,
    messageAreaRef,
  };
}

function mount(
  mode: Mode = { taskModeActive: false, taskSelectedNodeId: null, taskNodeSessionAgentId: null },
  shared?: Shared,
) {
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
    api = useFlow(props, shared);
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
    await new Promise((r) => realSetTimeout(r, 0));
  };
  return {
    get api() {
      return api!;
    },
    el,
    size,
    clickOpen,
    /** 用户往上翻到某个位置（真实环境里三件事自动发生）：滚轮向上先解除贴底跟随——不解除的话
     *  跟随循环会把位置拽回底部；位置变；滚动事件到，下一帧滚动系统量到位置。 */
    scrollTo: (top: number) => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400 }));
      el.scrollTop = top;
      el.dispatchEvent(new Event("scroll"));
      runFrames();
    },
    rerender: (m: Mode) => view.rerender(<Harness {...m} />),
    unmount: () => view.unmount(),
  };
}

const actEnvironmentBefore = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

/** 测试自己的「等一拍」用的真定时器——个别用例会接管 window.setTimeout（见 manualTimers）。 */
const realSetTimeout = window.setTimeout.bind(window);

/**
 * 遮蔽保险用的定时器：收进队列，时间由 clock 说了算（只接管 window.setTimeout——
 * 滚动系统调的就是它；React 调度器在模块加载时已经拿走了原函数，不受影响）。
 */
function manualTimers(clock: { now: number }) {
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  vi.spyOn(window, "setTimeout").mockImplementation(((fn: () => void, ms = 0) => {
    pending.set(++seq, { at: clock.now + ms, fn });
    return seq;
  }) as unknown as typeof window.setTimeout);
  vi.spyOn(window, "clearTimeout").mockImplementation(((id?: number) => {
    if (id !== undefined) pending.delete(id);
  }) as unknown as typeof window.clearTimeout);
  return {
    /** 时间走过 ms：中途到点的定时器按到点先后依次执行。 */
    elapse(ms: number) {
      const until = clock.now + ms;
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        clock.now = due[1].at;
        pending.delete(due[0]);
        due[1].fn();
      }
      clock.now = until;
    },
  };
}

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
  vi.restoreAllMocks();
});

describe("任务工作台的会话流程 · 三个钩子接在一起（从真实点击事件触发）", () => {
  it("有缓存时打开：定位指令在消息上屏的同一轮提交里就被消费——S24-U14a", async () => {
    invokeCommand.mockResolvedValue([msg("s1 的消息")]);
    const h = mount();
    await h.clickOpen("s1");
    expect(h.el.scrollTop).toBe(500); // 首次打开：到底
    // 往上翻一段再切走：记下这个位置
    h.scrollTo(200);
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
    // 主区还是主会话」的状态，否则补读会把主会话当成节点会话重读）。
    // 离开位置随选中态的变化记（二轮评审 R3 P1-1：导流钩子不再手动调记录）。
    const current = h.api;
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
    h.el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400 }));
    h.scrollTo(200);
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

describe("离开位置：记录只有一个写点，跟着选中态走（二轮评审 R3 · P1-1 / P2-3）", () => {
  const mode = { taskModeActive: false, taskSelectedNodeId: null, taskNodeSessionAgentId: null };

  it("经「新对话」离开再回来：停在离开的位置——R3-P1-1", async () => {
    setCachedSessionMessages("s1", [msg("s1 的消息")]);
    const h = mount();
    await h.clickOpen("s1");
    expect(h.el.scrollTop).toBe(500);
    h.scrollTo(200);
    // 「新对话」对状态做的事：选中态换成占位、消息清空（页面上不经打开函数）
    h.api.setSelectedSession("new");
    h.api.selectedSessionRef.current = "new";
    h.rerender(mode);
    await new Promise((r) => realSetTimeout(r, 0));

    await h.clickOpen("s1");
    expect(h.el.scrollTop).toBe(200);
  });

  it("切到管理页（页面卸载）再回来：停在离开的位置——R3-P1-1", async () => {
    setCachedSessionMessages("s1", [msg("s1 的消息")]);
    // 位置记忆由页面持有、跟软件同寿：卸载重挂也还在
    const shared = { scrollMemory: new Map<string, number | "bottom">(), visitedSessions: new Set<string>() };
    const first = mount(mode, shared);
    await first.clickOpen("s1");
    first.scrollTo(200);
    first.unmount();

    const second = mount(mode, shared);
    await second.clickOpen("s1");
    expect(second.el.scrollTop).toBe(200);
  });

  it("读盘没回来就切走：不把位置记成「底部」，原有的记忆保留——R3-P2-3", async () => {
    let release: (messages: Message[]) => void = () => {};
    invokeCommand.mockImplementation(() => new Promise<Message[]>((resolve) => { release = resolve; }));
    const memory = new Map<string, number | "bottom">();
    memory.set("s1", 200);
    const shared: Shared = { scrollMemory: memory, visitedSessions: new Set(["s1", "s2"]) };
    const h = mount(mode, shared);
    await h.clickOpen("s1");
    // 读盘期间：屏幕上是空的，指令还挂着
    expect(h.api.sessionMessages).toEqual([]);
    expect(h.api.scrollAction.current).toEqual({ type: "restore", top: 200, sessionId: "s1" });
    await h.clickOpen("s2");
    expect(shared.scrollMemory.get("s1")).toBe(200);
    release([msg("s1 的消息")]);
  });
});

describe("应用启动后的第一次打开：消息要从磁盘读（v0.9.8 评审修复轮 R2）", () => {
  /** 让读盘挂起，返回「放它回来」的函数。 */
  const holdRead = () => {
    let resolveRead: (messages: Message[]) => void = () => {};
    invokeCommand.mockImplementation(() => new Promise<Message[]>((resolve) => { resolveRead = resolve; }));
    return (messages: Message[]) => resolveRead(messages);
  };

  it("读回来那一帧直接在最底部——O1-U1", async () => {
    const release = holdRead();
    const h = mount();
    await h.clickOpen("s1");
    // 读盘还没回来：定位指令已经挂好（属于 s1），消息区遮着，屏幕上没有内容
    expect(h.api.scrollAction.current).toEqual({ type: "bottom", sessionId: "s1" });
    expect(h.el.style.visibility).toBe("hidden");
    expect(h.api.sessionMessages).toEqual([]);
    expect(h.el.scrollTop).toBe(0);

    release([msg("s1 的消息")]);
    await new Promise((r) => realSetTimeout(r, 0));
    // 消息上屏的同一帧指令被消费：先落到底，贴底首轮之后才上屏
    expect(h.api.sessionMessages).toEqual([msg("s1 的消息")]);
    expect(h.api.scrollAction.current).toBeNull();
    expect(h.el.scrollTop).toBe(500);
    expect(h.el.style.visibility).toBe("hidden");
    runFrames();
    expect(h.el.style.visibility).toBe("");
  });

  it("从往上翻着的会话切到另一个会话：新会话落到底，遮蔽随贴底首轮解除，后长出来的内容跟到底——O1-U7", async () => {
    setCachedSessionMessages("s1", [msg("s1 的消息")]);
    setCachedSessionMessages("s2", [msg("s2 的消息")]);
    const h = mount();
    await h.clickOpen("s1");
    runFrames();
    expect(h.el.scrollTop).toBe(500);
    // 在 s1 里往上翻：滚轮解除贴底，滚动事件把「离开底部」标记置真
    h.el.scrollTop = 200;
    h.el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400 }));
    h.el.dispatchEvent(new Event("scroll"));
    runFrames();
    expect(h.api.isAwayFromBottomRef.current).toBe(true);

    // 打开 s2（有缓存：消息就绪的同一轮提交里消费）
    await h.clickOpen("s2");
    expect(h.api.sessionMessages).toEqual([msg("s2 的消息")]);
    expect(h.api.scrollAction.current).toBeNull();
    expect(h.el.scrollTop).toBe(500);
    expect(h.api.isAwayFromBottomRef.current).toBe(false);
    expect(h.el.style.visibility).toBe("hidden");
    runFrames();
    expect(h.el.style.visibility).toBe("");
    // 内容继续撑高（图片、图表后置加载）：跟到新的底部
    h.size.scrollHeight = 1400;
    runFrames();
    expect(h.el.scrollTop).toBe(900);
  });

  it("离开再回来停到原处——走磁盘的那条读取路径——O1-U8", async () => {
    // 前两次读盘立刻返回；第三次（回到 s1）挂起
    let release = (_messages: Message[]) => {};
    invokeCommand
      .mockResolvedValueOnce([msg("s1 的消息")])
      .mockResolvedValueOnce([msg("s2 的消息")])
      .mockImplementationOnce(() => new Promise<Message[]>((resolve) => { release = (messages) => resolve(messages); }));
    const h = mount();
    await h.clickOpen("s1");
    runFrames();
    expect(h.el.scrollTop).toBe(500);
    h.scrollTo(200); // 往上翻一段再切走
    expect(h.api.lastScrollPositionOf("s1")).toBe(200); // 滚动系统量到了这次滚动
    await h.clickOpen("s2");
    deleteCachedSessionMessages("s1"); // 回来时消息要从磁盘读

    await h.clickOpen("s1");
    // 读盘期间：遮着、屏幕清空、指令是「恢复到 200」
    expect(h.api.scrollAction.current).toEqual({ type: "restore", top: 200, sessionId: "s1" });
    expect(h.el.style.visibility).toBe("hidden");
    expect(h.api.sessionMessages).toEqual([]);

    release([msg("s1 的消息")]);
    await new Promise((r) => realSetTimeout(r, 0));
    expect(h.api.scrollAction.current).toBeNull();
    expect(h.el.scrollTop).toBe(200);
    expect(h.el.style.visibility).toBe("");
  });

  it("读到空：遮蔽当场解除，不等保险；指令留着，以后有了内容再定位——O3-U2", async () => {
    invokeCommand.mockResolvedValue([]);
    const h = mount();
    await h.clickOpen("s1");
    expect(h.el.style.visibility).toBe("");
    expect(h.api.sessionMessages).toEqual([]);
    expect(h.api.scrollAction.current).toEqual({ type: "bottom", sessionId: "s1" });
  });

  it("装载失败：同样当场解除——O3-U3", async () => {
    invokeCommand.mockRejectedValue(new Error("disk boom"));
    const h = mount();
    await h.clickOpen("s1");
    expect(h.el.style.visibility).toBe("");
    expect(h.api.sessionMessages).toEqual([]);
  });

  it("读盘超过保险时长才回来：内容上屏时重新遮住，定位完成再上屏——O1-U4", async () => {
    const clock = { now: 0 };
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    const timers = manualTimers(clock);
    const release = holdRead();
    const h = mount();
    await h.clickOpen("s1");
    expect(h.el.style.visibility).toBe("hidden");
    // 保险到点（800 毫秒）：读盘还没回来，先不遮了
    timers.elapse(800);
    expect(h.el.style.visibility).toBe("");

    release([msg("s1 的消息")]);
    await new Promise((r) => realSetTimeout(r, 0));
    // 内容上屏：遮蔽与消息同一批武装；指令在同一帧被消费
    expect(h.api.sessionMessages).toEqual([msg("s1 的消息")]);
    expect(h.api.scrollAction.current).toBeNull();
    expect(h.el.scrollTop).toBe(500);
    expect(h.el.style.visibility).toBe("hidden");
    runFrames();
    expect(h.el.style.visibility).toBe("");
  });

  it("读盘期间去了「新对话」：旧指令作废、遮蔽解除，新对话页立即可见——O1-U6", async () => {
    holdRead();
    const h = mount();
    await h.clickOpen("s1");
    expect(h.el.style.visibility).toBe("hidden");
    // 页面的「新对话」：选中态改成占位、消息清空（不经打开函数）
    const current = h.api;
    current.setSelectedSession("new");
    await new Promise((r) => realSetTimeout(r, 0));
    expect(h.api.scrollAction.current).toBeNull();
    expect(h.el.style.visibility).toBe("");
  });
});
