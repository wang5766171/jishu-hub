/**
 * 任务执行段钩子单测——v0.9.8 需求24 续，对应 tests/06-测试清单 S24-U18。
 *
 * 「进入执行段拉到底」只在视图本来就在底部时才做（与普通会话的贴底跟随同一口径：用户没上翻才跟）。
 * 带任务图的任务每次重新打开都要重新加载任务图，这个副作用每次都会触发——视图停在中间
 *（刚按滚动记忆恢复）时不能被拽到底。「视图在不在底部」以滚动系统维护的标记为准：
 * 那个标记在程序性恢复位置的那一刻就由滚动系统当场更新（见 use-chat-scroll 的测试）。
 *
 * v0.9.8 评审修复轮 R2，对应 docs/v0.9.8/评审修复轮-R2/tests/O-用例清单.md：
 * O10-U1（「拉到底」排的两帧都要能取消）。
 *
 * jsdom 不排版：滚动容器的尺寸用属性替身，scrollTop 按浏览器的规矩压到可滚动范围内；
 * 逐帧回调收进数组里手动执行。
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseTaskGraphReturn as TaskGraphApi } from "@/features/task-instance/graph/use-task-graph";
import { useTaskExecutionStage } from "./use-task-execution-stage";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand: vi.fn(async () => []) }));

const frames: FrameRequestCallback[] = [];

/** 执行当前排队的帧（每个只跑一次；跑的过程中新排的帧留到下一轮）。 */
function runFrames() {
  const queued = frames.splice(0, frames.length);
  for (const frame of queued) frame(0);
}

type Props = { taskExecutionMode: boolean; taskRunStarted: boolean; projected: unknown[] };

function mount({ awayFromBottom }: { awayFromBottom: boolean }) {
  const el = document.createElement("div");
  const size = { scrollHeight: 1000, clientHeight: 500 };
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => size.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => size.clientHeight });
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, size.scrollHeight - size.clientHeight));
    },
  });
  // awayFromBottom=false：停在底部；true：停在中间（例如刚按滚动记忆恢复）
  el.scrollTop = awayFromBottom ? 120 : 500;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const isAwayFromBottomRef = { current: awayFromBottom };
  const hook = renderHook(
    (props: Props) => {
      const taskGraph = {
        snapshot: null,
        projectedMessages: props.projected,
        nodeRuns: {},
        activeRunId: null,
        runStatus: null,
      } as unknown as TaskGraphApi;
      return useTaskExecutionStage({
        taskExecutionMode: props.taskExecutionMode,
        taskRunStarted: props.taskRunStarted,
        activeTaskLaunchInstance: { task_id: "task-1", title: "验证", skill_id: "jishu-task-runner", status: "active" } as never,
        taskGraph,
        taskGraphRef: { current: taskGraph },
        boardRunId: null,
        projectPath: "E:/p",
        agents: [],
        confirmDialog: vi.fn(async () => true),
        isAwayFromBottomRef,
        messageAreaRef: { current: el },
        sessionMessagesLength: 2,
      });
    },
    { initialProps: { taskExecutionMode: false, taskRunStarted: true, projected: [] } as Props },
  );
  return { ...hook, el, size, isAwayFromBottomRef };
}

/**
 * 会真的取消的帧队列：按 id 登记，取消即移除（上面的替身只收集、取消是空操作，
 * 「排了之后被取消」这件事测不出来）。
 */
function cancellableFrames() {
  let seq = 0;
  const queued = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queued.set(++seq, cb);
    return seq;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queued.delete(id);
  });
  return {
    /** 执行当前排队的帧（跑的过程中新排的帧留到下一轮）。 */
    run() {
      const due = [...queued.values()];
      queued.clear();
      for (const frame of due) frame(0);
    },
  };
}

beforeEach(() => {
  frames.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTaskExecutionStage · 进入执行段的「拉到底」", () => {
  it("视图本来就在底部：进入执行段时跟到底（执行卡出现在下方也跟过去）——S24-U18①", () => {
    const h = mount({ awayFromBottom: false });
    h.rerender({ taskExecutionMode: true, taskRunStarted: true, projected: [] });
    // 执行卡在随后的帧里出现，内容变高
    h.size.scrollHeight = 1500;
    // 「拉到底」排在两帧之后——跑够两帧
    runFrames();
    runFrames();
    expect(h.el.scrollTop).toBe(1000);
  });

  it("视图停在中间（刚按滚动记忆恢复）：进入执行段时不被拽到底——S24-U18②", () => {
    const h = mount({ awayFromBottom: true });
    h.el.scrollTop = 120;
    h.rerender({ taskExecutionMode: true, taskRunStarted: true, projected: [] });
    h.size.scrollHeight = 1500;
    runFrames();
    runFrames();
    expect(h.el.scrollTop).toBe(120);
  });

  it("视图停在当前内容的底部、但「离开底部」标记为真（滚动记忆的恢复还没放到位，正在等内容长出来）：进入执行段时不动手——S24-U18⑥", () => {
    // 真实现场：回来时内容还没渲染完，要恢复的位置被压到当前内容的底部；随后任务图加载完，
    // 「进入执行段」被触发——此刻视图在半路上，不能被拽到底
    const h = mount({ awayFromBottom: true });
    h.el.scrollTop = 500;
    expect(h.isAwayFromBottomRef.current).toBe(true);
    h.rerender({ taskExecutionMode: true, taskRunStarted: true, projected: [] });
    h.size.scrollHeight = 1500;
    runFrames();
    runFrames();
    expect(h.el.scrollTop).toBe(500);
  });

  it("视图在底部时执行流有新内容：跟到底——S24-U18③", () => {
    const h = mount({ awayFromBottom: false });
    h.rerender({ taskExecutionMode: true, taskRunStarted: true, projected: [] });
    runFrames();
    runFrames();
    h.size.scrollHeight = 2000;
    h.rerender({ taskExecutionMode: true, taskRunStarted: true, projected: [{ kind: "event" }] });
    runFrames();
    expect(h.el.scrollTop).toBe(1500);
  });

  it("「离开底部」的标记在排帧之后、回调之前才变成真（视图被程序恢复到中间）：回调里再看一眼，不跟——S24-U18④", () => {
    // 打开带任务图的任务：排帧和回调之间，滚动系统按滚动记忆把视图恢复到中间，
    // 并当场把「离开底部」标记置真——回调不能再按排帧那一刻的旧判断把视图拽到底。
    const h = mount({ awayFromBottom: false });
    h.rerender({ taskExecutionMode: true, taskRunStarted: true, projected: [] });
    runFrames();
    runFrames();
    h.size.scrollHeight = 2000;
    h.rerender({ taskExecutionMode: true, taskRunStarted: true, projected: [{ kind: "event" }] });
    h.el.scrollTop = 120;
    h.isAwayFromBottomRef.current = true;
    runFrames();
    expect(h.el.scrollTop).toBe(120);
  });
});

describe("useTaskExecutionStage · 「进入执行段拉到底」排的两帧都要能取消", () => {
  // 执行还没启动：只有「进入拉底」这一处会滚（执行流贴底那一处要执行启动之后才生效）
  const enter = { taskExecutionMode: true, taskRunStarted: false, projected: [] };
  const leave = { taskExecutionMode: false, taskRunStarted: false, projected: [] };

  it("排了第一帧之后条件消失（退出执行段）：第二帧不再执行——O10-U1", () => {
    const h = mount({ awayFromBottom: false });
    const ff = cancellableFrames();
    h.rerender(enter);
    // 第一帧执行：第二帧已经排上；这时执行卡出现在下方，内容变高
    ff.run();
    h.size.scrollHeight = 1500;
    // 第一帧之后、第二帧之前退出执行段：清理把第二帧取消
    h.rerender(leave);
    ff.run();
    expect(h.el.scrollTop).toBe(500); // 没被拉到 1000（1500 - 500）
  });

  it("对照：两帧之间条件没变，第二帧照常把视图拉到底", () => {
    const h = mount({ awayFromBottom: false });
    const ff = cancellableFrames();
    h.rerender(enter);
    ff.run();
    h.size.scrollHeight = 1500;
    ff.run();
    expect(h.el.scrollTop).toBe(1000);
  });
});
