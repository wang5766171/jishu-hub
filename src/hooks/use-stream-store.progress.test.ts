/**
 * v0.9.4 需求8：工具执行进度链路（store 级）——
 * tool_use_start 登记 startedAt；tool_use_progress 更新 partialOutput
 * （仅提取 output 字符串字段，无则跳过；不建新条目）；
 * tool_use_result 回填 output + endedAt（partialOutput 保留供完成前一帧）。
 */
import { describe, expect, it } from "vitest";

import { streamStore } from "./use-stream-store";
import type { StreamChunk } from "@/types";

function chunk(data: StreamChunk["data"]): StreamChunk {
  return {
    session_id: "session-progress",
    event_type: data.kind,
    data,
  };
}

describe("streamStore tool execution progress（v0.9.4 需求8）", () => {
  it("start→progress→result 全链路：startedAt/partialOutput/output/endedAt", () => {
    streamStore.drop("session-progress");
    streamStore.start("session-progress", "build it");

    streamStore.push("session-progress", chunk({
      kind: "tool_use_start",
      call_id: "call-1",
      tool: "bash",
      input: { command: "for i in $(seq 1 45); do sleep 15; done" },
    }));
    let tools = streamStore.getState("session-progress")!.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].startedAt).toBeGreaterThan(0);
    expect(tools[0].partialOutput).toBeUndefined();

    streamStore.push("session-progress", chunk({
      kind: "tool_use_progress",
      call_id: "call-1",
      partial_output: "step 3/45 done",
    }));
    tools = streamStore.getState("session-progress")!.tools;
    expect(tools[0].partialOutput).toBe("step 3/45 done");
    expect(tools[0].output).toBeUndefined();

    // 完成回填：output/endedAt 就位（partialOutput 保留最后一帧，无渲染依赖）。
    streamStore.push("session-progress", chunk({
      kind: "tool_use_result",
      call_id: "call-1",
      output: "all done",
      is_error: false,
    }));
    tools = streamStore.getState("session-progress")!.tools;
    expect(tools[0].output).toBe("all done");
    expect(tools[0].endedAt).toBeGreaterThanOrEqual(tools[0].startedAt!);
  });

  it("progress 空字符串跳过；未知 call_id 不建条目", () => {
    streamStore.drop("session-progress");
    streamStore.start("session-progress", null);

    // 无 start 的迟到进度：不建条目（无渲染意义）。
    streamStore.push("session-progress", chunk({
      kind: "tool_use_progress",
      call_id: "ghost",
      partial_output: "x",
    }));
    expect(streamStore.getState("session-progress")!.tools).toHaveLength(0);

    streamStore.push("session-progress", chunk({
      kind: "tool_use_start",
      call_id: "call-2",
      tool: "bash",
      input: { command: "echo hi" },
    }));
    // 空字符串（归一化层无有效文本时不发，防御兜底）：跳过。
    streamStore.push("session-progress", chunk({
      kind: "tool_use_progress",
      call_id: "call-2",
      partial_output: "",
    }));
    expect(streamStore.getState("session-progress")!.tools[0].partialOutput).toBeUndefined();
  });
});
