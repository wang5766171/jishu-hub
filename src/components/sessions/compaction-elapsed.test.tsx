// v0.9.8 需求7 补充轮：上下文压缩的已用时间（UC-12）。
import { act, render } from "@testing-library/react";
import i18n from "@/i18n";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { streamStore } from "@/hooks/use-stream-store";
import type { StreamChunk } from "@/types";
import { CompactionElapsed, splitElapsed } from "./compaction-elapsed";
import { StreamingMessage } from "./streaming-message";

const SID = "session-compaction-elapsed";

function chunk(data: StreamChunk["data"]): StreamChunk {
  return { session_id: SID, event_type: data.kind, data };
}

describe("压缩用时（v0.9.8 需求7 补充轮）", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  afterEach(() => {
    streamStore.drop(SID);
    vi.useRealTimers();
  });

  it("splitElapsed：分钟数 + 不足一分钟的秒数", () => {
    expect(splitElapsed(0)).toEqual({ minutes: 0, seconds: 0 });
    expect(splitElapsed(59.9)).toEqual({ minutes: 0, seconds: 59 });
    expect(splitElapsed(65)).toEqual({ minutes: 1, seconds: 5 });
    expect(splitElapsed(7266)).toEqual({ minutes: 121, seconds: 6 });
    expect(splitElapsed(-5)).toEqual({ minutes: 0, seconds: 0 });
  });

  it("CompactionElapsed：不足一分钟按秒、每秒刷新；超过一分钟按分秒", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 24, 12, 0, 0));
    const short = render(<CompactionElapsed startedAt={Date.now() - 3_000} />);
    expect(short.container.textContent).toBe("已用时 3 秒");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(short.container.textContent).toBe("已用时 4 秒");
    short.unmount();

    const long = render(<CompactionElapsed startedAt={Date.now() - 65_000} />);
    expect(long.container.textContent).toBe("已用时 1 分 05 秒");
  });

  it("UC-12 流式消息：压缩进行中显示已用时间，终态分隔线到达后消失", () => {
    streamStore.start(SID, null);
    streamStore.push(SID, chunk({ kind: "phase_divider", phase: "compaction", title: "上下文压缩中…" }));
    expect(streamStore.getState(SID)?.compactionStartedAt).not.toBeNull();
    const running = render(<StreamingMessage sessionId={SID} />);
    expect(running.container.textContent).toMatch(/已用时 \d+ 秒/);
    running.unmount();

    streamStore.push(SID, chunk({ kind: "phase_divider", phase: "compaction", title: "上下文已压缩" }));
    expect(streamStore.getState(SID)?.compactionStartedAt).toBeNull();
    const done = render(<StreamingMessage sessionId={SID} />);
    expect(done.container.textContent).toContain("上下文已压缩");
    expect(done.container.textContent).not.toContain("已用时");
  });

  // 评审修复轮 R2（S12-U3 / S12-U4）：用例名说到的两件事此前没有断言——
  // 「终态之后重新起算」只断言了清零，「卸载后不再触发」整条没有用例。
  it("S12-U3 同一次压缩的后续进行态标题沿用首次时刻；终态之后新的进行态重新起算", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 24, 12, 0, 0));
    streamStore.start(SID, null);
    streamStore.push(SID, chunk({ kind: "phase_divider", phase: "compaction", title: "上下文压缩中…" }));
    const first = streamStore.getState(SID)?.compactionStartedAt;
    // 30 秒后又来一条进行态标题（重试横幅归并等）：同一次压缩，沿用首次时刻
    vi.setSystemTime(new Date(2026, 10, 24, 12, 0, 30));
    streamStore.push(SID, chunk({ kind: "phase_divider", phase: "compaction", title: "上下文压缩中…" }));
    expect(streamStore.getState(SID)?.compactionStartedAt).toBe(first);
    expect(streamStore.getState(SID)?.content.filter((b) => b.type === "phase_divider")).toHaveLength(1);
    // 终态：清零
    streamStore.push(SID, chunk({ kind: "phase_divider", phase: "compaction", title: "上下文压缩已取消" }));
    expect(streamStore.getState(SID)?.compactionStartedAt).toBeNull();
    // 5 分钟后的新一次压缩：从它自己的开始时刻起算，不是沿用上一次的
    vi.setSystemTime(new Date(2026, 10, 24, 12, 5, 0));
    streamStore.push(SID, chunk({ kind: "phase_divider", phase: "compaction", title: "上下文压缩中…" }));
    const second = streamStore.getState(SID)?.compactionStartedAt;
    expect(second).not.toBeNull();
    expect(second).toBe(new Date(2026, 10, 24, 12, 5, 0).getTime());
    expect(second).not.toBe(first);
  });

  it("S12-U4 卸载后计时器不再触发", () => {
    vi.useFakeTimers();
    const view = render(<CompactionElapsed startedAt={Date.now()} />);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("摘要生成的重试状态到达时，压缩分隔线下方出现重试横幅；重试结束横幅消失", () => {
    streamStore.start(SID, null);
    streamStore.push(SID, chunk({ kind: "phase_divider", phase: "compaction", title: "上下文压缩中…" }));
    streamStore.push(SID, chunk({
      kind: "auto_retry_status",
      active: true,
      attempt: 2,
      max_attempts: 3,
      delay_ms: 4000,
      error_message: "529 overloaded_error",
      success: false,
    }));
    const retrying = render(<StreamingMessage sessionId={SID} />);
    expect(retrying.container.textContent).toContain("2/3");
    expect(retrying.container.textContent).toContain("自动重试中");
    expect(retrying.container.textContent).toMatch(/已用时 \d+ 秒/);
    retrying.unmount();

    // 后端对「重试结束」发的是不带失败原因的清除：只收横幅，不记失败
    streamStore.push(SID, chunk({
      kind: "auto_retry_status",
      active: false,
      attempt: 0,
      max_attempts: 0,
      delay_ms: 0,
      error_message: "",
      success: false,
    }));
    const cleared = render(<StreamingMessage sessionId={SID} />);
    expect(cleared.container.textContent).not.toContain("自动重试中");
    expect(cleared.container.textContent).not.toContain("仍失败");
  });
});
